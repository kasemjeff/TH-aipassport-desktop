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

export class Compactor {
  /**
   * @param {object} opts
   * @param {number} opts.contextTokens  budget for everything sent so far (~chars/4)
   * @param {number} opts.reserveTokens  headroom to leave for the reply
   * @param {number} opts.keepRecentBytes recent traffic never summarised away
   */
  constructor({ bridge, events = null, contextTokens = 24_000, reserveTokens = 4_096, keepRecentBytes = 6_000 } = {}) {
    this.bridge = bridge;
    this.events = events;
    this.contextTokens = contextTokens;
    this.reserveTokens = reserveTokens;
    this.keepRecentBytes = keepRecentBytes;
  }

  /** Rough token estimate of what this session has sent, minus what is kept. */
  estimate(session) {
    if (!session) return 0;
    const sent = session.sentMessages();
    let bytes = 0;
    for (const m of sent) bytes += m.bytes ?? Buffer.byteLength(m.text ?? '');
    bytes -= this.keepRecentBytes;
    return Math.max(0, Math.round(bytes / 4));
  }

  needsCompaction(session) {
    if (!session) return false;
    return this.estimate(session) > this.contextTokens - this.reserveTokens;
  }

  /**
   * Ask the model for a summary of the work so far, in the conversation that
   * already holds the history — it is the only party that can see all of it.
   */
  async summarize(session, { task = '', model = null } = {}) {
    const sent = session.sentMessages().slice(-40);
    const transcript = sent.map((m) => m.text.slice(0, 1200)).join('\n---\n');
    const prompt = `Summarise the work carried out so far in this session, so it can continue in a fresh conversation.

Capture, in under 400 words: what was asked, what was found, what files were read, what was changed (path + what changed), what was decided, and what is still outstanding. Current task: ${task || '(none given)'}.

Conversation so far, oldest first:
${transcript}`;

    const res = await this.bridge.chat({ message: outbound(prompt), model });
    return res.text.trim();
  }

  /**
   * The first message of the rotated conversation: the summary, the task, and
   * the instruction frame that keeps the model inside the marker protocol.
   */
  seed({ summary, task, listing, preambleText }) {
    return `${preambleText}

Earlier work, already done — do not repeat it, build on it:
${summary || '(nothing recorded yet)'}

Task: ${task}

What should I open first?`;
  }
}
