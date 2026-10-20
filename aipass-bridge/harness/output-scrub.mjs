// What a command printed, before it becomes part of the transcript.
//
// A RUN is the machine's mouth. `set` (Windows) and `env` (POSIX) print the
// whole environment, a command may echo a token it read out of a config file,
// and the transcript is what goes upstream to the model — so anything a command
// prints can leave the machine. The command itself is screened for secret
// FILES (permissions.mjs); its OUTPUT is screened here, in two shapes:
//
//   - a known token by its own shape (`sk-…`, `ghp_…`, `AKIA…`, `Bearer …`) —
//     the same list the bridge scrubs out of its logs;
//   - an assignment whose NAME says it carries a credential (`API_KEY=…`,
//     `GITHUB_TOKEN=…`, `?_authToken=…`) — the shape an environment dump and
//     most config files have.
//
// Both are redactions, not refusals: the command still ran, the transcript
// still says what happened, and the value never leaves.
import { scrubSecrets } from '../bridge/log-scrub.mjs';

/** The words a variable name is made of when it carries a credential. */
const SECRET_WORDS = new Set([
  'pass', 'passwd', 'pwd', 'password', 'secret', 'token', 'key', 'keys',
  'credential', 'credentials', 'auth', 'authorization', 'cookie', 'session',
]);

/**
 * The words of a name: split on the separators AND on camelCase, so
 * `_authToken` is `auth` + `token` and `AWS_SECRET_ACCESS_KEY` is `aws` +
 * `secret` + `access` + `key`. A name that merely contains a word (`MONKEY`)
 * is not one — the split is what keeps it honest.
 */
const wordsOf = (name) => String(name)
  .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .split(/[^A-Za-z0-9]+/)
  .filter(Boolean)
  .map((w) => w.toLowerCase());

/** Does this variable name say it carries a credential? */
export function isSecretName(name) {
  return wordsOf(name).some((w) => SECRET_WORDS.has(w));
}

// `name=value`, wherever it sits in a line: an environment dump, a config
// file, a query string. The value stops at whitespace or an `&`, so a URL
// with two parameters is screened twice, not once.
const ASSIGNMENT = /(\b[A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^\s&"'`]*)/g;

/**
 * Screen a command's output: the token shapes first, then the assignments
 * whose name carries a credential.
 */
export function scrubOutput(text) {
  if (typeof text !== 'string' || !text) return text;
  const byShape = scrubSecrets(text);
  return byShape.replace(ASSIGNMENT, (whole, name, value) => (
    value && isSecretName(name) ? `${name}=[redacted]` : whole
  ));
}
