// Who is allowed to touch what.
//
// The upstream model speaks in prose markers, so a "write" is any of
// CREATE/EDIT/DELETE/MOVE and "shell" is RUN. Reads are always allowed — they
// cannot change anything, and holding the whole loop hostage to a question
// per file read would make the tool unusable.
//
// Three modes, matching how the CLI already worked:
//   ask      — every write and every shell command is confirmed (dry run)
//   auto     — writes go through without asking (the old `--apply`)
//   yolo     — writes and shell both go through (the old `--apply --allow-run`)
//
// On top of that: path rules (`docs/** → allow`, `.env* → deny`) that outrank
// the mode, and "always" answers so one confirmation covers a whole run.
export const WRITE_KINDS = new Set(['write', 'replace', 'delete', 'move']);
export const SHELL_KINDS = new Set(['run']);

export function classify(kind) {
  if (WRITE_KINDS.has(kind)) return 'write';
  if (SHELL_KINDS.has(kind)) return 'shell';
  return 'read';
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
  evaluate({ kind, arg = '' }) {
    const risk = classify(kind);
    if (risk === 'read') return { decision: 'allow', risk };

    if (this.grants.has(`${kind}:${arg}`)) return { decision: 'allow', risk, granted: true };

    // Path rules outrank the mode; first match wins.
    const file = arg.trim().split(/\s+/)[0] ?? '';
    for (const rule of this.rules) {
      if (rule.kinds && !rule.kinds.includes(kind)) continue;
      if (file && globMatch(rule.pattern, file)) {
        return { decision: rule.decision, risk, reason: `rule ${rule.pattern}` };
      }
    }

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
  async request({ kind, arg = '', preview = '' } = {}) {
    const risk = classify(kind);
    const verdict = this.evaluate({ kind, arg });
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
