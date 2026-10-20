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

// Conservative per-model context budgets (tokens). Used as the default when a
// surface does not name one, so a flash-class run no longer rotates every 9k
// tokens while a pro-class run still gets room. Prefix-matched in budgetFor()
// (key length >= 3), so more specific keys must come first.
export const DEFAULT_MODEL_BUDGETS = {
  'flash-lite': 100_000,
  'flash': 100_000,
  'pro': 200_000,
  'sonnet': 200_000,
  'opus': 200_000,
  'gpt-5': 200_000,
  'gpt-6': 200_000,
  'deepseek': 128_000,
  'qwen': 128_000,
  'llama': 128_000,
  'mistral': 128_000,
  'grok': 128_000,
  'gemini': 1_000_000,
};

// Scripts that do not separate words with spaces — Thai first among them —
// cost a tokenizer roughly twice as many tokens per byte as English. When the
// conversation's own text is mostly one of these, the byte estimate divides by
// less, so compaction fires before the upstream context is actually full. This
// project exists for Thai users; a flat bytes/4 made the budget about 2x too
// generous for exactly the people it is for.
const WIDE_SCRIPT = /[\u0590-\u05FF\u0600-\u06FF\u0900-\u097F\u0E00-\u0E7F\u0E80-\u0EFF\u1000-\u109F\u1780-\u17FF\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF]/;
// A global clone for counting: one scan per entry instead of a .test() per
// character, on a function the context meter calls on every tick. No /u — the
// class is all BMP and the count stays per UTF-16 unit, exactly what the
// per-character loop did.
const WIDE_SCRIPT_G = new RegExp(WIDE_SCRIPT.source, 'g');

// The elision tier (`elideStaleResults`, off by default — the queue record
// `elision-tier` is what flips the default): the summarisation transcript is
// the one bill the context manager pays for its own bookkeeping, and stale
// tool results dominate it. A stale message past the recency window is cut to
// a counted head…tail stub — its opening (what the output was) and its ending
// (the verdict or the error) — instead of the plain 1200-char slice that paid
// for the bulk either way. The slice's first message is never elided: it is
// the only candidate for the opening seed, where the task statement sits.
// Turning the tier on can only shrink the transcript, never grow it.
const ELIDE_MIN_CHARS = 1200; // only messages the plain slice would cut anyway
const ELIDE_KEEP_RECENT = 8;  // the newest sends stay whole — they carry the live state
const ELIDE_HEAD = 240;
const ELIDE_TAIL = 240;

// The memory tier (`carryMemory`, on by default; `AIPASS_MEMORY=off`): the
// durable facts a rotation must not lose — decisions, constraints, files.
// The summariser is asked for them as a trailing MEMORY: section on the same
// call (one bill, two products); they merge across rotations (deduped,
// clipped, capped), record on the compaction entry, and pin into every later
// seed. A reply without the section costs nothing — the narrative is
// unchanged and the facts simply stay in prose. The cap is the failure
// behavior: an overflow drops the oldest facts, never the newest.
const MEMORY_FACTS_MAX = 20;
const MEMORY_FACT_MAX = 200; // chars per fact

const envPositive = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// A boolean env switch, the sibling of envPositive: unset means the option
// stands; `1/true/on/yes` turns it on and anything else turns it off. The
// CLI builds no settings object, so these are the tuning channel a terminal
// run has — and what the experiment arms run against.
const envFlag = (name, fallback = false) => {
  const v = String(process.env[name] ?? '').trim().toLowerCase();
  if (!v) return fallback;
  return v === '1' || v === 'true' || v === 'on' || v === 'yes';
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
   * @param {boolean} [opts.elideStaleResults] the elision tier: cut stale,
   *                                     bulky sends in the summarisation
   *                                     transcript to head…tail stubs. Off by
   *                                     default — the `elision-tier` arm is
   *                                     what flips it; `AIPASS_ELIDE` turns it
   *                                     on for a terminal run.
   * @param {boolean} [opts.carryMemory] the memory tier: extract the durable
   *                                     facts from the summary reply, merge
   *                                     them across rotations, and pin them
   *                                     into every later seed. On by default;
   *                                     `AIPASS_MEMORY=off`.
   */
  constructor({ bridge, events = null, contextTokens = 24_000, budgets = null, reserveTokens = 4_096, compactAtPercent = null, keepRecentBytes = 6_000, elideStaleResults = false, carryMemory = true } = {}) {
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
    this.elideStaleResults = envFlag('AIPASS_ELIDE', Boolean(elideStaleResults));
    this.carryMemory = envFlag('AIPASS_MEMORY', carryMemory !== false);
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
    return Math.max(0, Math.round(bytes / this.divisorFor(entries, start)));
  }

  /**
   * Bytes-per-token divisor, measured on a sample of the entries the estimate
   * actually counts — the current conversation, not what a rotation left
   * behind: mostly Latin script → 4, a real mix of scripts → 3, mostly
   * wide-script → 2.
   */
  divisorFor(entries, start = 0) {
    let total = 0, wide = 0, seen = 0;
    for (let i = entries.length - 1; i >= start && seen < 40_000; i--) {
      const t = entries[i].text;
      if (typeof t !== 'string' || !t) continue;
      seen += t.length;
      total += t.length;
      wide += t.match(WIDE_SCRIPT_G)?.length ?? 0;
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
   * The summarisation transcript: the last sends, each sliced to 1200 chars —
   * and, when the elision tier is on, stale bulky ones cut to a counted
   * head…tail stub instead. Head and tail survive because they are the parts
   * a summary can use: the opening says what the output was, the ending
   * usually carries the verdict or the error; the middle is the bulk the
   * slice was paying for either way. This shrinks this one call's bill —
   * what the server holds is untouched.
   */
  transcriptFor(sent) {
    const staleBelow = Math.max(0, sent.length - ELIDE_KEEP_RECENT);
    return sent.map((m, i) => {
      const text = String(m?.text ?? '');
      // The slice's first message is the only one that can be the opening
      // seed — where the task statement sits when the conversation is young;
      // never elided, at the cost of one message's worth of saving.
      if (!this.elideStaleResults || i === 0 || i >= staleBelow || text.length <= ELIDE_MIN_CHARS) {
        return text.slice(0, 1200);
      }
      const middle = text.length - ELIDE_HEAD - ELIDE_TAIL;
      return `${text.slice(0, ELIDE_HEAD)}\n… [elided ${middle} chars of a stale tool result — it ran; its outcome and any follow-up are in the later steps] …\n${text.slice(-ELIDE_TAIL)}`;
    }).join('\n---\n');
  }

  /**
   * Ask the model for a summary of the work so far, in the conversation that
   * already holds the history — it is the only party that can see all of it.
   * The memory ask rides the same call (one bill, two products); a model that
   * ignores the format still compacts correctly, because digest() falls back
   * to the text as written.
   * The conversation is named explicitly (when there is one): the bridge's
   * shared pointer can have been moved by another session's run since this
   * one started, and a summary request is the one message that must land in
   * the conversation it is summarising.
   */
  async summarize(session, { task = '', model = null, conversation = null, temporary = null, signal = null } = {}) {
    const sent = session.sentMessages().slice(-40);
    const transcript = this.transcriptFor(sent);
    const memoryAsk = this.carryMemory
      ? `\n\nAfter the summary, on its own line, write exactly MEMORY: and then up to 10 bullet lines ("- " prefix, each under 200 characters) holding only durable facts a future conversation must not rediscover — a decision and its reason (prefix "decision:"), a constraint ("constraint:"), a file path and its role ("file:"). No other bullets; if nothing qualifies, leave the section empty.`
      : '';
    const prompt = `Summarise the work carried out so far in this session, so it can continue in a fresh conversation.

Capture, in under 400 words: what was asked, what was found, what files were read, what was changed (path + what changed), what was decided, and what is still outstanding. Keep every proper noun, name, number, date, filename and quoted string exactly as written — never translate, shorten or paraphrase them; Thai text stays Thai. Current task: ${task || '(none given)'}.${memoryAsk}

Conversation so far, oldest first:
${transcript}`;

    // The signal rides the call like it rides a run's send: a run that was
    // stopped while the summary was being asked for must not wait for the
    // answer — the abort ends the fetch, and the run ends with it.
    const res = await this.bridge.chat({
      message: outbound(prompt), model,
      ...(conversation ? { conversation, temporary } : {}),
      ...(signal ? { signal } : {}),
    });
    return res.text.trim();
  }

  /**
   * Split a summariser reply into its two products: the narrative, and the
   * trailing MEMORY: facts (when the tier is on). Lenient by design — the
   * label is matched case-insensitively on a line of its own (markdown
   * emphasis tolerated), bullets are `-`/`*`/`•`/`N.` lines under it, and a
   * reply without the section returns the text untouched with an empty list.
   */
  splitSummary(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return { summary: '', memory: [] };
    const lines = text.split('\n');
    let at = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      const label = lines[i].trim().replace(/^\*+|\*+$/g, '').trim();
      if (/^MEMORY:?$/i.test(label)) { at = i; break; }
    }
    if (at === -1) return { summary: text, memory: [] };
    const memory = [];
    for (const line of lines.slice(at + 1)) {
      const bullet = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.+)$/);
      if (bullet) memory.push(bullet[1].trim());
    }
    return { summary: lines.slice(0, at).join('\n').trim(), memory };
  }

  /**
   * The facts the latest rotation carried, read off the newest compaction
   * entry — empty for a session that never rotated, or one whose record
   * predates the memory tier. A missing field is zero facts to merge, not a
   * problem to fix.
   */
  memoryOf(session) {
    const entries = session?.entries ?? [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e?.type === 'compaction') return Array.isArray(e.memory) ? e.memory : [];
    }
    return [];
  }

  /**
   * prev + fresh, oldest first, deduped and capped: a fact never rides twice
   * (case- and whitespace-insensitive), one runaway bullet cannot eat the
   * budget the memory exists to save, and an overflow drops the oldest facts
   * — the newest are what a live run is building on.
   */
  mergeMemory(prev = [], fresh = []) {
    const out = [];
    const seen = new Set();
    for (const raw of [...prev, ...fresh]) {
      const fact = String(raw ?? '').replace(/\s+/g, ' ').trim();
      if (!fact) continue;
      const clipped = fact.length > MEMORY_FACT_MAX ? `${fact.slice(0, MEMORY_FACT_MAX - 1)}…` : fact;
      const key = clipped.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(clipped);
    }
    return out.slice(-MEMORY_FACTS_MAX);
  }

  /**
   * One rotation's two products, ready to record and seed. The merge reads
   * the session, so the cap accumulates across rotations instead of per
   * call; the off-switch refuses the whole tier whatever is already stored —
   * the seed stops mentioning facts the moment `carryMemory` is off.
   */
  digest(session, raw) {
    const { summary, memory } = this.splitSummary(raw);
    return {
      summary,
      memory: this.carryMemory ? this.mergeMemory(this.memoryOf(session), memory) : [],
    };
  }

  /**
   * The first message of a rotated conversation: the summary, the task, and
   * the instruction frame that keeps the model inside the marker protocol.
   * A mid-run rotation pastes the step's tool results on top, so nothing the
   * model asked for is lost to the rotation itself. Three harder-won things
   * ride along when the caller has them: the staged file list (edits the
   * summary may compress away), the last failing check, pinned verbatim so
   * the fresh conversation does not repeat either by accident, and the
   * merged memory facts — the distilled backbone the narrative is a
   * rephrasing of.
   */
  seed({ summary, task, preambleText, results = null, staged = null, lastCheck = null, memory = null, todo = null }) {
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
      Array.isArray(todo) && todo.length
        ? `\nThe plan/TODO checklist this run recorded, as it stands — keep it in step (send TODO with [x] as items finish):\n${todo.map((i) => `- [${i.done ? 'x' : ' '}] ${i.text}`).join('\n')}`
        : '',
    ].join('');
    // Facts ride next to the narrative, and only when there are any — a seed
    // without them is byte-for-byte what it always was.
    const facts = Array.isArray(memory) && memory.length
      ? `\n\nFacts carried from earlier rotations (durable; re-check anything that may have gone stale):\n${memory.map((m) => `- ${m}`).join('\n')}`
      : '';
    return `${preambleText}

Earlier work, already done — do not repeat it, build on it:
${summary || '(nothing recorded yet)'}${facts}

Task: ${task}${carried}

${tail}`;
  }
}
