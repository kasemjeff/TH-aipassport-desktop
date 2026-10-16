// Compaction, and the honest way to do it here.
//
// The upstream keeps its own conversation history and only accepts ONE user
// message per request — there is no API for trimming what the server already
// remembers. So "context is filling up" cannot be solved by dropping messages;
// it is solved by rotating: summarise the work carried so far, start a fresh
// temporary conversation, and re-seed it with that summary plus the task.
//
// Everything about the summary is local and durable (it lands in the session
// as a compaction entry), so a session opened next week still reads as one
// continuous piece of work.
import { outbound } from './waf.mjs';

// Scripts that do not separate words with spaces — Thai first among them —
// cost a tokenizer roughly twice as many tokens per byte as English. When the
// conversation's own text is mostly one of these, the byte estimate divides by
// less, so compaction fires before the upstream context is actually full. This
// project exists for Thai users; a flat bytes/4 made the budget about 2x too
// generous for exactly the people it is for.
const WIDE_SCRIPT = /[\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\u0E80-\u0EFF\u1000-\u109F\u1780-\u17FF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/;

const envPositive = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export class Compactor {
  /**
   * @param {object} opts
   * @param {number} opts.contextTokens  default budget for everything the current
   *                                     conversation holds (~chars/4)
   * @param {object} [opts.budgets]      per-model budgets: an exact model id or a
   *                                     substring of one → tokens, e.g.
   *                                     { 'flash': 100_000 }. Unknown models get
   *                                     contextTokens — conservative by default.
   * @param {number} opts.reserveTokens  headroom to leave for the reply
   * @param {number} [opts.compactAtPercent] share of the budget at which a rotation
   *                                     fires early. null (the default) leaves the
   *                                     budget-minus-reserve ceiling in sole charge,
   *                                     which is what the CLI runs on; the window's
   *                                     settings sheet owns that knob.
   * @param {number} opts.keepRecentBytes recent traffic never summarised away
   */
  constructor({ bridge, events = null, contextTokens = 24_000, budgets = null, reserveTokens = 4_096, compactAtPercent = null, keepRecentBytes = 6_000 } = {}) {
    this.bridge = bridge;
    this.events = events;
    this.budgets = budgets ?? {};
    // The env overrides exist because the CLI builds no settings object — they
    // are the one tuning channel a terminal run has, and the tests use them to
    // reach the threshold without huge fixtures.
    this.contextTokens = envPositive('AIPASS_CONTEXT_TOKENS', contextTokens);
    this.keepRecentBytes = envPositive('AIPASS_KEEP_RECENT_BYTES', keepRecentBytes);
    this.reserveTokens = reserveTokens;
    this.compactAtPercent = compactAtPercent == null ? null : Math.min(100, Math.max(1, Number(compactAtPercent)));
  }

  /** The share of the budget the window rotates at, or null when unset. */
  get triggerPercent() { return this.compactAtPercent; }

  /** The budget for the model this run talks to. */
  budgetFor(model = null) {
    const m = String(model ?? this.bridge?.model ?? '').toLowerCase();
    if (m) {
      if (this.budgets[m] != null) return this.budgets[m];
      for (const [key, tokens] of Object.entries(this.budgets)) {
        if (key.length >= 3 && m.includes(key.toLowerCase())) return tokens;
      }
    }
    return this.contextTokens;
  }

  /**
   * Rough token estimate of what the current conversation holds — what the
   * server actually remembers, not what the session file has ever recorded.
   * Three corrections over a flat bytes/4 over all user messages:
   *
   *   - entries before the last compaction live in a conversation that was
   *     rotated away; counting them would fire compaction again on every
   *     later run, forever
   *   - the model's replies sit in the server's context too, so assistant
   *     entries count alongside the user ones
   *   - `pending` is the message being assembled right now — the paste of
   *     tool results the server is about to receive. Without it the check
   *     always ran one message behind the reality. It arrives as the raw
   *     local text and is measured after outbound() rewrites: the session's
   *     own entries already record the encoded form (that is what the server
   *     holds), and the pending message has to be counted the same way or a
   *     step full of URLs and HTML sails under the budget it actually exceeds.
   */
  estimate(session, { pending = '' } = {}) {
    if (!session) return 0;
    const entries = session.entries;
    let start = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].type === 'compaction') { start = i + 1; break; }
    }
    let bytes = pending ? Buffer.byteLength(outbound(String(pending))) : 0;
    for (let i = start; i < entries.length; i++) {
      const e = entries[i];
      if (e.type === 'user') bytes += e.bytes ?? Buffer.byteLength(e.text ?? '');
      else if (e.type === 'assistant') bytes += Buffer.byteLength(e.text ?? '');
    }
    bytes -= this.keepRecentBytes;
    return Math.max(0, Math.round(bytes / this.divisorFor(entries)));
  }

  /**
   * Bytes-per-token divisor, measured on a sample of the conversation itself:
   * mostly Latin script → 4, a real mix of scripts → 3, mostly wide-script → 2.
   */
  divisorFor(entries) {
    let total = 0, wide = 0, seen = 0;
    for (let i = entries.length - 1; i >= 0 && seen < 40_000; i--) {
      const t = entries[i].text;
      if (typeof t !== 'string' || !t) continue;
      seen += t.length;
      for (let j = 0; j < t.length; j++) {
        total++;
        if (WIDE_SCRIPT.test(t[j])) wide++;
      }
    }
    const share = total ? wide / total : 0;
    return share > 0.3 ? 2 : share > 0.08 ? 3 : 4;
  }

  needsCompaction(session, { pending = '' } = {}) {
    if (!session) return false;
    const budget = this.budgetFor();
    // Two ceilings, whichever comes first: the share of the budget the window's
    // sheet names (when it names one), and the hard budget minus the reserve.
    // The second is the safety net that stops a reply being cut off by a
    // context that no longer fits; the first is the knob, and the reason it
    // exists is that waiting until the budget is nearly spent means the last
    // stretch of a run re-sends a context that is already too big.
    if (this.compactAtPercent != null && this.estimate(session, { pending }) >= Math.round(budget * (this.compactAtPercent / 100))) return true;
    return this.estimate(session, { pending }) > budget - this.reserveTokens;
  }

  /**
   * Ask the model for a summary of the work so far, in the conversation that
   * already holds the history — it is the only party that can see all of it.
   */
  async summarize(session, { task = '', model = null } = {}) {
    const sent = session.sentMessages().slice(-40);
    const transcript = sent.map((m) => m.text.slice(0, 1200)).join('\n---\n');
    const prompt = `Summarise the work carried out so far in this session, so it can continue in a fresh conversation.

Capture, in under 400 words: what was asked, what was found, what files were read, what was changed (path + what changed), what was decided, and what is still outstanding. Keep every proper noun, name, number, date, filename and quoted string exactly as written — never translate, shorten or paraphrase them; Thai text stays Thai. Current task: ${task || '(none given)'}.

Conversation so far, oldest first:
${transcript}`;

    const res = await this.bridge.chat({ message: outbound(prompt), model });
    return res.text.trim();
  }

  /**
   * The first message of a rotated conversation: the summary, the task, and
   * the instruction frame that keeps the model inside the marker protocol.
   * A mid-run rotation pastes the step's tool results on top, so nothing the
   * model asked for is lost to the rotation itself. Two harder-won things
   * ride along when the caller has them: the staged file list (edits the
   * summary may compress away) and the last failing check, pinned verbatim so
   * the fresh conversation does not repeat either by accident.
   */
  seed({ summary, task, listing, preambleText, results = null, staged = null, lastCheck = null }) {
    const tail = results
      ? `Here are the results of the step just finished:\n${results}\n\nContinue the task from there.`
      : 'What should I open first?';
    const carried = [
      staged?.length
        ? `\nStaged but not on disk yet (Apply has not happened):\n${staged.map((s) => `- ${s}`).join('\n')}`
        : '',
      lastCheck
        ? `\nThe last check of the staged tree did not pass (${lastCheck.verdict}):\n${String(lastCheck.text ?? '').slice(0, 600)}`
        : '',
    ].join('');
    return `${preambleText}

Earlier work, already done — do not repeat it, build on it:
${summary || '(nothing recorded yet)'}

Task: ${task}${carried}

${tail}`;
  }
}
