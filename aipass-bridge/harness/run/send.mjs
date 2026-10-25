// @ts-check
// The send pipeline: one message out, and the reply that comes back.
//
// The chain, in order (docs/LOOP_DESIGN.md):
//
//   say        → the bridge, with the run's model, thinking level and signal
//   saySafe    → the same message, but rewritten when the edge refuses it:
//                 the risky lines dropped, a big message shortened, a refusal
//                 that is about pace waited out, and only then the message
//                 halved and resent
//   the retry  → the loop's own bounded recovery: a send that delivered
//                 nothing and heals by waiting is paused and given the same
//                 message again
//
// The ladder lives here so the policy is one file: the resume swap (a dead
// conversation), the recoverable waits and the final "error" are three
// different endings and they used to be one `catch` block deep inside a
// thousand-line function.
import { resilientSay, recoverWaits, sendRecoverable, waitLabel } from '../bridge.mjs';
import { RunContext } from './context.mjs';

/**
 * A pause the run itself takes — the recovery waits between send attempts.
 *
 * @param {number} ms
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The send stage of one run.
 *
 * @param {RunContext} run
 */
export function createSender(run) {
  /**
   * One message to the model.
   *
   * Both sides are recorded only after the send was accepted: a message the
   * firewall rejected never reached the server's context, and recording it
   * before the attempt would turn every retry into a duplicate — the session
   * must hold the conversation the server actually remembers.
   *
   * @param {string} text
   * @param {any} [withParts]
   */
  const say = async (text, withParts = null) => {
    // What streamed before the send died. A send that delivered words the
    // person SAW is a different failure from one that delivered nothing: the
    // message reached the server's context either way, and the transcript
    // has to hold what was on screen — dsh calls this the interrupted anchor.
    let delivered = '';
    try {
      const res = await run.bridge.chat({
        message: text,
        parts: withParts ?? null,
        model: run.sheet.model,
        thinkingLevel: run.sheet.thinking,
        temperature: run.sheet.temperature,
        ...(run.conversation ? { conversation: run.conversation, temporary: run.conversationTemporary } : {}),
        signal: run.options.signal ?? null,
        onText: (/** @type {string} */ t) => { delivered += t; run.emit('assistant_delta', { text: t }); },
        onReasoning: (/** @type {string} */ t) => run.emit('reasoning_delta', { text: t }),
      });
      run.session?.append('user', { text, bytes: Buffer.byteLength(text) });
      run.session?.append('assistant', { text: res.text, reasoning: res.reasoning });
      return res.text;
    } catch (err) {
      // (interrupted anchor) Deltas streamed, then the send died — a stop, or
      // a refusal that arrives after the answer started (`err.streamed`, which
      // the rewrite chain never resends over). The words reached the server
      // and the person's screen, so both sides are recorded: the message as
      // sent, and the delivered prefix marked `interrupted` — the next send's
      // reply continues a conversation whose transcript holds what came
      // before it, instead of pretending nothing streamed. A failure with
      // nothing delivered records nothing: the retry path may resend the same
      // message, and a duplicate user entry would be a lie about what the
      // server ever received.
      if (delivered) {
        run.session?.append('user', { text, bytes: Buffer.byteLength(text) });
        run.session?.append('assistant', { text: delivered, interrupted: true });
      }
      throw err;
    }
  };

  /**
   * The message, sent the way the edge can take it.
   *
   * The run's first message carries the protocol, so it is never shortened: a
   * protocol with its middle cut out is worse than a message that waited.
   *
   * @param {string} text
   * @param {any} [parts]
   */
  const saySafe = (text, parts = null) => {
    const note = (/** @type {number} */ _level, /** @type {string} */ t) => {
      run.firewallNotes += 1;
      run.emit('firewall_note', { text: t });
    };
    return resilientSay(say, text, /** @type {any} */ (note), /** @type {any} */ (parts), 0, {
      encode: run.waf, firewall: run.waf, shrink: run.sends > 0,
    });
  };

  /**
   * The parts this send carries.
   *
   * Attachments ride the first message only: the server keeps the history, so
   * re-sending the same image on every step would re-upload it and occupy the
   * context again for nothing. ATTACH queues (the tool's own) drain into the
   * next message, whatever turn that is.
   */
  const partsForSend = () => {
    const queued = Array.isArray(run.tools.pendingParts) ? run.tools.pendingParts.splice(0) : [];
    const base = run.sends === 0 && Array.isArray(run.firstParts) ? run.firstParts : [];
    return base.length || queued.length ? [...base, ...queued] : null;
  };

  /**
   * Send the run's message and hand the reply back.
   *
   * The three endings are the three things that can go wrong with a send, and
   * each one says which:
   *   - a stop         → `cancelled` (an ending, not a failure)
   *   - a dead conversation → one swap, on the run's first send only
   *   - a refusal      → the bounded recovery, and then `error`
   *
   * @returns {Promise<{reply: string|null, stopReason: string|null}>}
   */
  const send = async () => {
    const recover = recoverWaits();
    for (let attempt = 0; ; attempt++) {
      try {
        const reply = await saySafe(run.next, partsForSend());
        // (listing delta) The memory only becomes true once the message that
        // carries the listing was accepted. The first send of the run is the
        // composed message; every later message carries results or the seed,
        // never the table.
        if (run.sends === 0 && run.listingToRecord != null && run.conversation && run.listingShown instanceof Map) {
          run.listingShown.set(run.conversation, run.listingToRecord);
        }
        run.sends += 1;
        // (resume) The conversation just took one of this session's messages:
        // the harness settles the binding (persisted for a reopen) and commits
        // a resume seed's boundary. Idempotent, and failures here must never
        // end a run — the message is already out.
        try { run.onConversationSettled?.({ conversation: run.conversation, temporary: run.conversationTemporary }); } catch { /* best effort */ }
        return { reply, stopReason: null };
      } catch (err) {
        // The failure is whatever the edge threw; its own name and message
        // are what the run's ending is made of.
        const why = /** @type {any} */ (err);
        // The user pressed stop: the signal ends the in-flight fetch with an
        // AbortError, which is an ending, not a failure — the transcript should
        // not read "error" for something the user did on purpose.
        if (why?.name === 'AbortError') return { reply: null, stopReason: 'cancelled' };
        // (resume) The conversation this session adopted is gone upstream — a
        // temporary that expired, one deleted by hand. Only the run's first
        // send can recover: nothing of this run has entered the old one, so
        // the harness can hand back a fresh conversation plus the transcript
        // digest. Mid-run the history is already there to lose, and an error
        // stays the honest ending. The check runs before the generic recovery
        // below: a dead named conversation never heals by waiting.
        if (attempt === 0 && run.sends === 0 && !run.swappedConversation && run.onConversationDead
            && /conversation not found|returned 404|returned 409/i.test(String(why?.message ?? ''))) {
          run.swappedConversation = true;
          const swapped = await Promise.resolve()
            .then(() => run.onConversationDead())
            .catch(() => null);
          if (swapped?.conversation) {
            run.conversation = swapped.conversation;
            run.conversationTemporary = swapped.temporary === true;
            if (swapped.seedText) {
              run.next = swapped.seedText;
              run.listingToRecord = null;
            }
            const line = `the session's conversation is gone upstream - a fresh one (${swapped.conversation}) was created and seeded from the transcript`;
            run.note(line);
            run.emit('note', { text: line });
            continue;
          }
        }
        // A send that delivered nothing and heals by waiting — the extension's
        // cycle, a tab mid-reload, a rate window, a 403 the rewrite chain could
        // not clear — is paused and given the same message again before it is
        // allowed to end the run (sendRecoverable says which shapes; the waits
        // are bounded). The ending below is what stays when they are spent.
        if (attempt < recover.length && sendRecoverable(why)) {
          const wait = recover[attempt];
          run.sendRecoveries += 1;
          const line = `the send was refused — waiting ${waitLabel(wait)}, then sending it again (recovery ${attempt + 1}/${recover.length})`;
          run.note(line);
          run.emit('firewall_note', { text: line });
          await sleep(wait);
          continue;
        }
        run.emit('error', { message: why.message });
        // Keep the reason a run died: the UI event is ephemeral, and 40% of
        // runs ended this way before the recovery above — without a note the
        // session keeps no trace of why.
        run.note(`the send failed: ${why.message}`);
        run.sendError = String(why.message ?? why);
        // The one failure with an obvious cause and an obvious fix: the bridge is
        // up and the extension is connected, but no logged-in chat tab is open, so
        // there is nowhere for the request to run. Say so on its own event, and
        // whoever is watching gets to fix it in one click instead of reading a
        // stack trace. Both spellings: the dispatch refusal ("no extension
        // connected — open a de.aipass.net tab") and the tab's own report.
        if (/no extension connected|no de\.aipass\.net tab is open/i.test(why.message)) {
          run.emit('needs_tab', { url: run.options.chatUrl ?? 'https://de.aipass.net/chat', reason: why.message });
        }
        return { reply: null, stopReason: 'error' };
      }
    }
  };

  return { say, saySafe, partsForSend, send };
}

export default createSender;
