// What a candidate policy is allowed to say.
//
// An optimizer that edits the harness is an optimizer that can edit the rules
// the harness holds the model to. Two things follow, and both are enforced
// here, deterministically, before a candidate is ever run:
//
//  1. A candidate may not weaken the floor. The permission gate, the secret
//     screen, the verification duty and the DONE contract are not the
//     optimizer's to trade away for a better score. A candidate that tries is
//     refused, not scored.
//  2. A candidate may not arrive mangled. The bytes the model reads have been
//     through the outbound WAF table, and that table rewrites ordinary code
//     shapes (`==`, `&&`, `localhost`, `console.log`, `process.env`). A policy
//     carrying one of those tokens would reach the model changed — so the
//     check is the table itself: the candidate must survive `outbound()`
//     byte-identical.
//
// The Verifier Tax is the reason these are deterministic checks and not a
// model judging a model: a cheap check that always agrees beats an expensive
// one that sometimes does. A candidate that passes here is still only
// PROPOSED — the score decides whether it ships.
import { outbound } from '../waf.mjs';
import { POLICY_MAX_BYTES } from './policy.mjs';

/**
 * The floor. Each pattern is a phrase that would hand the model a way around
 * a guard. They are matched case-insensitively; a candidate that trips one is
 * refused, and the pattern that tripped is named in the refusal.
 */
export const SAFETY_FLOOR = [
  { re: /\bignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|user|system|above-the-line)\b/i, detail: 'asks the model to ignore instructions' },
  { re: /\bwithout\s+(?:asking|confirmation|approval|permission|consent)\b/i, detail: 'asks the model to act without asking' },
  { re: /\bskip\s+(?:the\s+)?(?:permission|confirmation|guard|check|checks|verification|review)\b/i, detail: 'asks the model to skip a check' },
  { re: /\bdisabl(?:e|ing)\s+(?:the\s+)?(?:safety|guard|guards|permission|permissions|sandbox|verification|check|checks|waf|secret)\b/i, detail: 'asks the model to disable a guard' },
  { re: /\bbypass\b/i, detail: 'asks the model to bypass a gate' },
  { re: /\bdo\s+not\s+(?:verify|check|run\s+the\s+(?:test|tests|check|checks))\b/i, detail: 'asks the model to skip verification' },
  { re: /\bnever\s+(?:verify|check|run\s+the\s+(?:test|tests))\b/i, detail: 'asks the model to never verify' },
  { re: /\bno\s+need\s+to\s+(?:ask|confirm|verify|check)\b/i, detail: 'removes the need to ask or verify' },
  { re: /\b(?:cat|type|print|read|show|send|echo)\b[^\n]{0,40}\.env\b/i, detail: 'points the model at a secret file' },
  { re: /\b(?:always|auto)[- ]?(?:approve|allow|yes|run|accept)\b/i, detail: 'approves actions without a person' },
  { re: /\bDONE\b[^\n]{0,60}\b(?:even\s+if|without\s+(?:a\s+)?(?:check|test|verif))/i, detail: 'loosens the DONE contract' },
  { re: /\bclaim\b[^\n]{0,40}\bwithout\b/i, detail: 'asks the model to claim without evidence' },
  { re: /\bpretend\b[^\n]{0,40}\b(?:done|verified|tested)\b/i, detail: 'asks the model to pretend' },
];

/** The markers this harness knows. A candidate that teaches a marker the
 *  parser does not have produces replies nothing can read. */
export const KNOWN_MARKERS = new Set([
  'NEED', 'SEARCH', 'GLOB', 'SYMBOLS', 'DEF', 'REFS', 'RECALL', 'SKILL', 'GIT', 'VERIFY', 'FETCH', 'WEB',
  'DELETE', 'MOVE', 'EDIT', 'CREATE', 'ATTACH', 'FIND', 'NEW', 'END', 'RUN', 'PLAN',
  'TODO', 'SUBAGENT', 'TASK', 'ASK', 'JOBS', 'DONE',
]);

/**
 * Check a candidate document. Pure — no IO, no clock — so the suite can call
 * it on a string.
 *
 * `ok` means "may be proposed and measured". It does not mean the change is
 * good: the score does that, and the score is the only thing that does.
 */
export function checkCandidate({ dimension = null, text = '', base = '' } = {}) {
  const problems = [];
  const warnings = [];
  const body = String(text ?? '');

  if (!body.trim()) {
    problems.push({ rule: 'empty', detail: 'an empty policy is a deletion, not an edit' });
    return { ok: false, problems, warnings };
  }

  const bytes = Buffer.byteLength(body);
  if (bytes > POLICY_MAX_BYTES) {
    problems.push({ rule: 'size', detail: `${bytes} bytes over the ${POLICY_MAX_BYTES}-byte budget for one dimension` });
  }

  if (String(base ?? '').trim() && body.trim() === String(base).trim()) {
    warnings.push({ rule: 'no-change', detail: 'the candidate is byte-identical to the policy it replaces' });
  }

  for (const { re, detail } of SAFETY_FLOOR) {
    if (re.test(body)) problems.push({ rule: 'safety-floor', detail });
  }

  // The WAF table is the single source of truth (root rule 4) — asking it is
  // asking the real thing, not a copy of it.
  if (outbound(body) !== body) {
    problems.push({ rule: 'waf-token', detail: 'the text carries a token the outbound table rewrites, so the model would read it changed' });
  }

  // A marker the parser does not have: the model would emit a line nothing
  // can act on. A warning, not a refusal — a word in prose can be a word.
  const shouted = body.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? [];
  const unknown = [...new Set(shouted.filter((w) => !KNOWN_MARKERS.has(w)))];
  if (unknown.length) {
    warnings.push({ rule: 'unknown-marker', detail: `not a marker this harness knows: ${unknown.slice(0, 6).join(', ')}` });
  }

  // Machine-facing prose stays English (the root guide's style rule); the
  // model's replies are the thing that is Thai.
  if (/[฀-๿]/.test(body)) {
    warnings.push({ rule: 'language', detail: 'machine-facing text stays English in this repository' });
  }

  return { ok: problems.length === 0, problems, warnings, bytes };
}

/** The rules, in prose — the CLI prints them and the brief quotes them. */
export const RULE_TEXT = [
  'one dimension per change — the other five documents stay byte-identical',
  'additive: the overlay adds rules, it never removes the built-in protocol',
  `bounded: one document stays under ${POLICY_MAX_BYTES} bytes`,
  'the floor stands: permissions, the secret screen, verification and the DONE contract are not negotiable',
  'the text must survive the outbound WAF table byte-identical',
  'the score decides: passing these checks only makes a change eligible to be measured',
].join('\n');
