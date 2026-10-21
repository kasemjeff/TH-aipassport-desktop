// The policy half of the harness: what this machine tells the model about
// itself, in prose, one document per dimension.
//
// AHE edits a harness one component at a time and keeps the change only when
// the score moves. That needs the component to be a FILE, not a paragraph
// inside a function — so each dimension's editable half is a document on
// disk, and this module is the runtime that reads it.
//
// Natural-language harnesses: the policy is prose, and the runtime
// interprets it by handing it to the model. Nothing here parses meaning out
// of it — the model is the interpreter, the score is the judge. What this
// module guarantees is narrower and worth stating: the overlay is additive
// (it can add a rule, never remove the built-in protocol), it is bounded
// (a per-document and a total budget), and it never breaks a run (a policy
// that cannot be read is skipped, never thrown).
//
// The reading is bounded on purpose. Six NAMED files, no directory walk, and
// a short cache: the backend process serves every window call, so loading a
// policy must never be a filesystem crawl.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { aipassHome } from '../settings.mjs';
import { writeFileAtomic } from '../atomic-write.mjs';

// MemoHarness's six dimensions, mapped onto this harness. The ids are the
// file names: `generation.md`, `tool.md`, … — one document each, so a
// candidate edit names its own file and touches nothing else.
export const DIMENSIONS = ['generation', 'tool', 'context', 'memory', 'orchestration', 'output'];

// The overlay rides the first message of a conversation, so its size is a
// token cost on every single run. The budget is what keeps "the policy grew"
// from becoming "the preamble doubled".
export const POLICY_MAX_BYTES = 1200;
export const POLICY_MAX_TOTAL_BYTES = 3000;

// How long a loaded policy stays fresh. The backend can pick a new policy up
// within a second of it landing, without a restart and without a file read on
// every window call.
const CACHE_TTL_MS = 1000;

const digestOf = (text) => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);

/** Where the policy documents live. `AIPASS_POLICY_DIR` wins, so an eval arm
 *  can point at a candidate policy without touching the live one. */
export const policyDir = () => process.env.AIPASS_POLICY_DIR?.trim() || path.join(aipassHome(), 'harness', 'policy');

export const policyFile = (dimension, dir = policyDir()) => path.join(dir, `${dimension}.md`);

/**
 * A tiny front matter: a leading `---` block of `key: value` lines. The only
 * key that means anything today is `enabled`; the rest is room for the
 * optimizer to record where a rule came from without inventing a parser.
 */
function parseFrontMatter(text) {
  if (!text.startsWith('---')) return { meta: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end < 0) return { meta: {}, body: text };
  const meta = {};
  for (const line of text.slice(3, end).split(/\r?\n/)) {
    const m = /^\s*([a-zA-Z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (m) meta[m[1].toLowerCase()] = m[2].trim();
  }
  const body = text.slice(end + 4).replace(/^\r?\n/, '');
  return { meta, body };
}

const isEnabled = (meta) => (meta.enabled === undefined ? true : !/^(false|no|0|off|disabled)$/i.test(meta.enabled));

/**
 * One policy document. A missing file is the normal case (no policy yet),
 * not an error: the harness then behaves exactly as it did before.
 */
export function readDocument(dimension, dir = policyDir()) {
  const file = policyFile(dimension, dir);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { dimension, file, exists: false, text: '', body: '', meta: {}, enabled: false, bytes: 0, digest: null };
  }
  const { meta, body } = parseFrontMatter(text);
  return {
    dimension,
    file,
    exists: true,
    text,
    body: body.trim(),
    meta,
    enabled: isEnabled(meta),
    bytes: Buffer.byteLength(text),
    digest: digestOf(text),
  };
}

/** Write a policy document atomically: temp file plus rename, so a crash
 *  mid-write leaves the previous policy in place. */
export function writeDocument(dimension, text, dir = policyDir()) {
  const file = policyFile(dimension, dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, text);
  return readDocument(dimension, dir);
}

/** Load every dimension's document. Bounded: DIMENSIONS named files, no walk. */
export function loadPolicy(dir = policyDir()) {
  const documents = {};
  let bytes = 0;
  let enabled = [];
  for (const dimension of DIMENSIONS) {
    const doc = readDocument(dimension, dir);
    documents[dimension] = doc;
    if (doc.exists && doc.enabled) {
      bytes += doc.bytes;
      enabled.push(dimension);
    }
  }
  const loaded = enabled
    .map((d) => documents[d].digest)
    .filter(Boolean)
    .join('|');
  return { dir, documents, enabled, bytes, digest: loaded ? digestOf(loaded) : null };
}

let cache = { dir: null, at: 0, policy: null };

/**
 * The policy the runtime uses. Synchronous on purpose — the preamble builder
 * is synchronous — but the read is bounded (six small files) and cached for a
 * second, so the backend never crawls a tree to answer a window call.
 */
export function currentPolicy(dir = policyDir()) {
  const now = Date.now();
  if (cache.policy && cache.dir === dir && now - cache.at < CACHE_TTL_MS) return cache.policy;
  const policy = loadPolicy(dir);
  cache = { dir, at: now, policy };
  return policy;
}

/** Drop the cache — called after a policy lands, so the next run sees it. */
export function invalidatePolicy() {
  cache = { dir: null, at: 0, policy: null };
}

/**
 * The overlay text that rides the first message. Empty when no document is
 * enabled, which keeps the built-in preamble byte-identical — the replay
 * fingerprint in `evals/fixtures/` depends on that.
 */export function composePolicy(policy, { dimensions = null } = {}) {
  if (!policy?.enabled?.length) return '';
  const wanted = dimensions ?? policy.enabled;
  const blocks = [];
  for (const dimension of wanted) {
    const doc = policy.documents?.[dimension];
    if (!doc?.exists || !doc.enabled) continue;
    const body = String(doc.body ?? '').trim();
    if (!body) continue;
    blocks.push(`### ${dimension}\n${body}`);
  }
  if (!blocks.length) return '';
  return [
    'Rules for this machine. They were written by the harness\'s own tuning loop and they add to the protocol above — they never replace it, and they never lift a rule about permissions, secrets or verification.',
    '',
    blocks.join('\n\n'),
  ].join('\n');
}
