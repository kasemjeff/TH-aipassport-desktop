// Who is allowed to touch what.
//
// The upstream model speaks in prose markers, so a "write" is any of
// CREATE/EDIT/DELETE/MOVE and "shell" is RUN. Reads are allowed by default —
// they cannot change anything, and holding the whole loop hostage to a question
// per file read would make the tool unusable — but a deny rule still outranks
// that default, because `.env* → deny` exists to keep secrets on this machine.
//
// Three modes, matching how the CLI already worked:
//   ask      — every write and every shell command is confirmed (dry run)
//   auto     — writes go through without asking (the old `--apply`)
//   yolo     — writes and shell both go through (the old `--apply --allow-run`)
//
// On top of that: path rules (`docs/** → allow`, `.env* → deny`) that outrank
// the mode, and "always" answers so one confirmation covers a whole run.
import { SAFETY_RULES } from './settings.mjs';
export const WRITE_KINDS = new Set(['write', 'replace', 'delete', 'move']);
export const SHELL_KINDS = new Set(['run']);

/** kind → 'read' | 'write' | 'shell' | 'shell-risk'. A RUN's command lives in
 *  `body`, never in `arg` (protocol.mjs), so the kind alone cannot tell an
 *  ordinary command from a destructive one — classifyRun reads the text. */
export function classify(kind, body = '') {
  if (WRITE_KINDS.has(kind)) return 'write';
  if (SHELL_KINDS.has(kind)) return classifyRun(body);
  return 'read';
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

/** Minimal glob: `**` spans path separators, `*` does not. */
export function globMatch(pattern, text) {
  const re = new RegExp('^' + String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*') + '$', 'i');
  return re.test(text);
}

export class PermissionEngine {
  /**
   * @param {object}   opts
   * @param {string}   opts.mode    'ask' | 'auto' | 'yolo'
   * @param {boolean}  opts.allowRun  shell is permitted at all
   * @param {Array}    opts.rules   [{pattern, decision, kinds?}]
   * @param {Function} opts.askFn   ({id, kind, arg, preview, risk}) => 'allow'|'deny'|'always'
   * @param {Function} [opts.onGrant] (kind, arg) => void — write-through when an
   *                                "always" answer is recorded, so it survives
   *                                a restart (harness/rules.mjs)
   * @param {object}   opts.events  Emitter; `permission_request` goes out on it
   */
  constructor({ mode = 'ask', allowRun = false, rules = [], askFn = null, events = null, timeoutMs = 120_000, onGrant = null } = {}) {
    this.mode = mode;
    this.allowRun = allowRun;
    this.rules = rules;
    this.askFn = askFn;
    this.events = events;
    this.timeoutMs = timeoutMs;
    this.onGrant = onGrant;
    this.grants = new Map();  // `${kind}:${arg}` → 'allow'
    this.pending = new Map(); // id → {resolve, kind, arg}
  }

  /** What the policy says, before any question is asked. */
  evaluate({ kind, arg = '', body = '' }) {
    const risk = classify(kind, body);
    // A hazardous RUN body is a question no mode pre-answers — yolo included.
    // It sits ahead of the grants check too: a grant is keyed `${kind}:${arg}`
    // and every RUN carries `arg: ''`, so one "always" would otherwise blanket
    // every command that ever runs, including the one it was never asked about.
    if (risk === 'shell-risk') return { decision: 'ask', risk };
    if (risk !== 'read' && this.grants.has(`${kind}:${arg}`)) return { decision: 'allow', risk, granted: true };

    // Path rules outrank the mode — and they cover reads too, because
    // `.env* → deny` is how secrets stay on this machine even when the model
    // asks for the file with NEED. First match wins.
    const file = arg.trim().split(/\s+/)[0] ?? '';
    for (const rule of this.rules) {
      if (rule.kinds && !rule.kinds.includes(kind)) continue;
      if (file && globMatch(rule.pattern, file)) {
        return { decision: rule.decision, risk, reason: `rule ${rule.pattern}` };
      }
    }

    // The safety floor (settings.mjs SAFETY_RULES) sits under the user's own
    // rules and over the mode: mutating a file a build resolves through is a
    // question even in yolo, because the mistake is invisible until something
    // else breaks. Reads never match — every rule carries mutation kinds only.
    // A MOVE names two paths and both are checked; a write names one.
    const files = arg.trim().split(/\s+/).filter(Boolean);
    for (const rule of SAFETY_RULES) {
      if (rule.kinds && !rule.kinds.includes(kind)) continue;
      if (files.some((f) => globMatch(rule.pattern, f))) {
        return { decision: rule.decision, risk, reason: `rule ${rule.pattern}` };
      }
    }

    // A read that no rule named is allowed: it cannot change anything.
    if (risk === 'read') return { decision: 'allow', risk };
    if (this.mode === 'yolo') return { decision: 'allow', risk };
    if (risk === 'write' && this.mode === 'auto') return { decision: 'allow', risk };
    if (risk === 'shell' && this.mode === 'auto' && this.allowRun) return { decision: 'allow', risk };
    return { decision: 'ask', risk };
  }

  /**
   * Ask the human.
   *
   * `askFn` is an override for callers that already know the policy (tests).
   * The default path puts the question on the `permission_request` event and
   * waits for `answer()`. If nobody is listening there is no one to ask, so the
   * call is refused rather than hanging the run forever.
   */
  async request({ kind, arg = '', preview = '', body = '' } = {}) {
    const risk = classify(kind, body);
    const verdict = this.evaluate({ kind, arg, body });
    if (verdict.decision !== 'ask') return verdict.decision;

    if (this.askFn) return verdictFnAnswer(await this.askFn({ id: 'direct', kind, arg, preview, risk }));

    if (!this.events?.isObserved('permission_request')) return 'deny';

    const id = Math.random().toString(16).slice(2, 10);
    const decided = new Promise((resolve) => this.pending.set(id, { resolve, kind, arg }));
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

  /** Record an "always" grant so the same question is not asked again. */
  grant(kind, arg = '') {
    this.grants.set(`${kind}:${arg}`, 'allow');
    this.onGrant?.(kind, arg);
  }

  /** Called by the UI when the human answers a pending question. */
  answer(id, decision) {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    if (decision === 'always') this.grant(entry.kind, entry.arg);
    entry.resolve(decision);
    return true;
  }

  pendingCount() { return this.pending.size; }
}

const verdictFnAnswer = (d) => (d === 'always' || d === 'allow-always' ? 'always' : d === 'allow' ? 'allow' : 'deny');
