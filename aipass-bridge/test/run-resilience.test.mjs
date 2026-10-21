// The four-minute blip, pinned.
//
// The extension cycles its SSE connection to the bridge every four minutes
// (extension/background.js CYCLE_MS — "reconnect before Chrome's long-request
// ceiling"), and for the few seconds around each cycle the bridge has no tab
// to dispatch to, so a send that lands in that gap is refused instantly with
// "no extension connected". Recorded failure: the user's runs of Oct 16,
// 10:57 local, died with stopReason "error" mid-task — one dispatch line in
// the backend log sits between "extension disconnected" and "extension
// connected". These tests pin the client-side cure: the gap is retried, a
// refusal after the answer started streaming is not (a resend would deliver
// the text twice), and a conversation create survives the same gap.
//
// Its sibling, recorded the same afternoon: the edge answers 429 when the
// account moves too fast (ten messages in four minutes drew one), the page
// waits the request out inside the tab (extension/page.js RETRY_WAITS_MS —
// 5s/15s/45s, retry-after honoured), and the tests below pin the layer above
// it — a rate window longer than the page's budget is waited out here too,
// under the same "never after a delta streamed" rule.
//
// Recorded again Oct 17, live, and the refuser was the cure's own line: the
// page's waiting line used to ride tool status — a reasoning delta — and the
// client read any reasoning as "the answer started", closing the very gate
// the wait needed open. The waiting line is a note now (extension/page.js),
// and one test below plays that exact sequence: note first, 429 second,
// retry expected.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBridge, FakeExtension, scripted, waitFor } from './harness.mjs';
import { BridgeClient, resilientSay } from '../harness/bridge.mjs';

let bridge;
before(async () => { bridge = await startBridge(); });
after(() => bridge.stop());

const extCount = () => fetch(`${bridge.base}/status`).then((r) => r.json()).then((s) => s.extensions);
const noExtension = () => waitFor(async () => (await extCount()) === 0, { timeout: 3000 });

test('a send refused while the extension is away is retried, not lost', async (t) => {
  await noExtension();
  const client = new BridgeClient(bridge.base);

  // The first attempt hits a bridge with no extension attached — the exact
  // refusal a cycle gap leaves behind. The extension comes back well inside
  // the retry window, the way it does in the browser three seconds later.
  const pending = client.chat({ message: 'hi' });
  const ext = await new FakeExtension(bridge.base, { onChat: scripted(['กลับมาแล้วครับ']) }).connect();
  t.after(() => ext.disconnect());

  const res = await pending;
  assert.match(res.text, /กลับมาแล้วครับ/, 'the retried send reached the extension');
  assert.equal(ext.chats.length, 1, 'and it was delivered exactly once');
});

test('the client claims the refusal — the tab hands it back instead of probing', async (t) => {
  // The chain that can actually fix a refused message (drop the risky lines,
  // shorten it, halve it) lives in the client, and the tab cannot see it. So
  // the client says so on every send, and the extension then hands a 403 back
  // at once: re-sending the identical bytes there was a probe of a window
  // that was already hot, and it put the client's fix 75 seconds away.
  const ext = await new FakeExtension(bridge.base, { onChat: scripted(['ok']) }).connect();
  t.after(() => ext.disconnect());

  const client = new BridgeClient(bridge.base);
  await client.chat({ message: 'hi' });
  assert.equal(ext.chats.length, 1, 'the job reached the tab');
  assert.equal(ext.chats[0].rewriteOnRefusal, true, 'the job says the client rewrites a refusal');
});

test('a refusal after the answer started streaming is not retried', async (t) => {
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (_job, e) => {
      await e.text('ครึ่งแรก');
      await e.error('no extension connected — pretend the pipe broke mid-answer');
    },
  }).connect();
  t.after(() => ext.disconnect());

  const client = new BridgeClient(bridge.base);
  await assert.rejects(() => client.chat({ message: 'hi' }), /no extension connected/);
  assert.equal(ext.chats.length, 1, 'the refusal surfaced instead of resending the half-delivered text');
});

test('a conversation create survives the same gap', async (t) => {
  await noExtension();
  const client = new BridgeClient(bridge.base);

  const pending = client.createConversation({ temporary: true, message: 'Starting a new working session.' });
  const ext = await new FakeExtension(bridge.base).connect();
  t.after(() => ext.disconnect());

  const made = await pending;
  assert.ok(made?.id, 'the create answered with an id after the retry');
  assert.equal(ext.created.length, 1, 'one create reached the extension');
});

/* The 429 layer — a rate window longer than the page's own budget ---------- */

test('a 429 refused send is waited out and retried, not lost', async (t) => {
  let refused = 0;
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (_job, e) => {
      if (refused++ === 0) {
        return void e.error('aipass returned 429  [2046 bytes] {server=cloudflare via=1.1 google} — <!doctype html><title>429</title>');
      }
      await e.text('ผ่านแล้วครับ');
      await e.done();
    },
  }).connect();
  t.after(() => ext.disconnect());

  const notes = [];
  const client = new BridgeClient(bridge.base, { rateWaits: [20, 20], onNote: (text) => notes.push(text) });
  const res = await client.chat({ message: 'hi' });
  assert.match(res.text, /ผ่านแล้วครับ/, 'the retried send reached the extension');
  assert.equal(ext.chats.length, 2, 'refused once, accepted on the second attempt');
  assert.match(notes.join('\n'), /429/, 'and the wait was reported, not silent');
});

test('a 429 that never clears surfaces after the waits, not before them', async (t) => {
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (_job, e) => void e.error('aipass returned 429  [2046 bytes] {server=cloudflare}'),
  }).connect();
  t.after(() => ext.disconnect());

  const client = new BridgeClient(bridge.base, { rateWaits: [10, 10] });
  await assert.rejects(() => client.chat({ message: 'hi' }), /429/);
  assert.equal(ext.chats.length, 3, 'the first send plus two waits — then the failure is real');
});

test('a 429 after the answer started streaming is not retried', async (t) => {
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (_job, e) => {
      await e.text('ครึ่งแรก');
      await e.error('aipass returned 429  [2046 bytes] — pretend the limiter cut the tail');
    },
  }).connect();
  t.after(() => ext.disconnect());

  const client = new BridgeClient(bridge.base, { rateWaits: [10, 10] });
  await assert.rejects(() => client.chat({ message: 'hi' }), (err) => {
    assert.match(err.message, /429/);
    assert.equal(err.streamed, true, 'the mark that keeps the rewrite chain off a delivered answer');
    return true;
  });
  assert.equal(ext.chats.length, 1, 'a half-delivered answer is never resent');
});

/* The note channel — a site message that is not the answer ----------------- */

test('a note part mid-stream surfaces as a note, never in the answer', async (t) => {
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (_job, e) => {
      await e.text('คำตอบ');
      await e.note('the site switched this conversation\'s model mid-reply to "gemini-3.5-flash-lite" — replies continue on the substitute');
      await e.done();
    },
  }).connect();
  t.after(() => ext.disconnect());

  const notes = [];
  const client = new BridgeClient(bridge.base, { onStreamNote: (text) => notes.push(text) });
  const res = await client.chat({ message: 'hi' });
  assert.match(res.text, /คำตอบ/);
  assert.doesNotMatch(res.text, /switched/, 'a note must not leak into the answer');
  assert.equal(notes.length, 1, 'the note arrived exactly once');
  assert.match(notes[0], /gemini-3\.5-flash-lite/, 'and it names the substitute');
  // The reasoning echo is deliberate: a chat console that never learned the
  // note field still sees the line where it always saw it.
  assert.match(res.reasoning, /switched/);
});

test('a 429 is waited out even when the page\'s waiting note streamed first', async (t) => {
  let refused = 0;
  const ext = await new FakeExtension(bridge.base, {
    onChat: async (_job, e) => {
      if (refused++ > 0) {
        await e.text('ผ่านแล้วครับ');
        await e.done();
        return;
      }
      // The live shape, verbatim: the page writes its waiting line while the
      // edge refuses (a note — not the answer), the in-place retries run out,
      // and only then does the 429 surface. That note must not read as an
      // answer delta, or the gate above is shut and the refusal is fatal.
      await e.note('[429] rate limited by the edge — waiting 5s, then retrying (2/4)');
      await e.error('aipass returned 429  [2046 bytes] {server=cloudflare via=1.1 google} — <!doctype html><title>429</title>');
    },
  }).connect();
  t.after(() => ext.disconnect());

  const notes = [];
  const streamNotes = [];
  const client = new BridgeClient(bridge.base, {
    rateWaits: [20, 20],
    onNote: (text) => notes.push(text),
    onStreamNote: (text) => streamNotes.push(text),
  });
  const res = await client.chat({ message: 'hi' });
  assert.match(res.text, /ผ่านแล้วครับ/, 'the retried send reached the extension');
  assert.equal(ext.chats.length, 2, 'the note did not close the gate — the refused send was retried');
  assert.match(notes.join('\n'), /429/, 'and the client wait was reported, not silent');
  assert.match(streamNotes.join('\n'), /waiting 5s/, 'the page\'s waiting line arrived as a stream note');
  assert.doesNotMatch(res.text, /rate limited/, 'the note never leaked into the answer');
});

/* The pace-403, and what must not stack ------------------------------------ */

// Recorded live, Oct 17 2026: not every 403 is about the content. The edge
// also refuses by pace score, and the identical bytes go through a moment
// later (a 214-byte tool result refused and then accepted unchanged; a read
// refused whole while both of its halves passed on their own). The message
// layer's answer is the 429 treatment — wait, then the same text again — not
// a rewrite that fragments a run the edge is already unhappy with.
test('a flaky refusal is waited out with the identical message, never rewritten', async () => {
  const saved = process.env.AIPASS_EDGE_WAITS_MS;
  process.env.AIPASS_EDGE_WAITS_MS = '5,5';
  try {
    const sent = [];
    const notes = [];
    let calls = 0;
    const say = async (t) => {
      sent.push(t);
      if (++calls === 1) throw new Error('aipass returned 403 Forbidden {server=cloudflare}');
      return 'ok';
    };
    const text = 'an ordinary tool result with nothing a filter would look for\n'.repeat(8);
    await resilientSay(say, text, (_lvl, t) => notes.push(t));

    assert.equal(sent.length, 2, 'the refusal plus one resend');
    assert.equal(sent[1], sent[0], 'the resend was the very same message');
    assert.ok(notes.some((t) => /refused at the edge — waiting/.test(t)), 'the pause is reported as a note');
    assert.ok(!notes.some((t) => /splitting/.test(t)), 'no split for a refusal that was pace');
    assert.ok(!notes.some((t) => /omitting/.test(t)), 'and nothing was dropped for it');
  } finally {
    if (saved === undefined) delete process.env.AIPASS_EDGE_WAITS_MS;
    else process.env.AIPASS_EDGE_WAITS_MS = saved;
  }
});

// A big message the edge refuses whole, and keeps refusing, is a payload the
// filter does not want — waiting longer does not make it smaller. Recorded
// live, Oct 20 2026: a run in the desktop window read a file, the message
// carrying the result was refused, and the run stood still for the four
// minutes the waits add up to; the session ended after the tool call, with no
// answer and no run_stats, because the window was closed while it waited.
//
// So a big message is sent again SHORTER, right away: the head and the tail
// survive, the middle is left out with a line that says so, and the run's
// next step happens. A small message is never shortened — that is the pace
// case, and the waits are its medicine.
test('a refused big message is sent again, shorter, so the run continues', async () => {
  const saved = process.env.AIPASS_EDGE_WAITS_MS;
  process.env.AIPASS_EDGE_WAITS_MS = '0';
  try {
    const sent = [];
    const notes = [];
    const say = async (t) => {
      sent.push(t);
      if (sent.length === 1) throw new Error('aipass returned 403 Forbidden {server=cloudflare}');
      return 'ok';
    };
    const text = `Result of read README.md:\n${'a line of the file that the edge does not want\n'.repeat(60)}\n\nWhat next? Ask for anything else you need, or finish with DONE if you have enough.`;
    await resilientSay(say, text, (_lvl, t) => notes.push(t));

    assert.equal(sent.length, 2, 'the refusal plus one shorter resend');
    assert.ok(sent[1].length < sent[0].length, 'the resend was shorter');
    assert.ok(sent[1].startsWith('Result of read README.md:'), 'it still says what it carries');
    assert.match(sent[1], /finish with DONE/, 'and it still says how to finish');
    assert.match(sent[1], /left out of this message/, 'the cut says what was cut');
    assert.ok(notes.some((t) => /sending a shorter version/.test(t)), 'the shortening is announced');
  } finally {
    if (saved === undefined) delete process.env.AIPASS_EDGE_WAITS_MS;
    else process.env.AIPASS_EDGE_WAITS_MS = saved;
  }
});

test('a refused small message is waited out, never shortened', async () => {
  const saved = process.env.AIPASS_EDGE_WAITS_MS;
  process.env.AIPASS_EDGE_WAITS_MS = '5,5';
  try {
    const sent = [];
    const notes = [];
    let calls = 0;
    const say = async (t) => {
      sent.push(t);
      if (++calls === 1) throw new Error('aipass returned 403 Forbidden {server=cloudflare}');
      return 'ok';
    };
    const text = 'a small tool result the edge refused\n'.repeat(20);
    await resilientSay(say, text, (_lvl, t) => notes.push(t));

    assert.equal(sent.length, 2, 'the refusal plus one resend');
    assert.equal(sent[1], sent[0], 'the resend was the very same message');
    assert.ok(!notes.some((t) => /shorter version/.test(t)), 'a small message is not shortened');
  } finally {
    if (saved === undefined) delete process.env.AIPASS_EDGE_WAITS_MS;
    else process.env.AIPASS_EDGE_WAITS_MS = saved;
  }
});

// The run's FIRST message carries the protocol — the marker list, the rules —
// and a protocol with its middle cut out is worse than a message that waited.
// The loop says so (the first send asks for no shorter copy) and the layer
// obeys it.
test('the message that carries the protocol is never shortened', async () => {
  const saved = process.env.AIPASS_EDGE_WAITS_MS;
  process.env.AIPASS_EDGE_WAITS_MS = '5,5';
  try {
    const sent = [];
    const notes = [];
    let calls = 0;
    const say = async (t) => {
      sent.push(t);
      if (++calls === 1) throw new Error('aipass returned 403 Forbidden {server=cloudflare}');
      return 'ok';
    };
    const text = `I am reading through a project with you.\n\nNEED dir .\n${'a marker rule of the protocol\n'.repeat(80)}\nWhat next?`;
    await resilientSay(say, text, (_lvl, t) => notes.push(t), null, 0, { shrink: false });

    assert.equal(sent.length, 2, 'the refusal plus one resend');
    assert.equal(sent[1], sent[0], 'the resend was the very same message');
    assert.ok(!notes.some((t) => /shorter version/.test(t)), 'the instruction was not shortened');
  } finally {
    if (saved === undefined) delete process.env.AIPASS_EDGE_WAITS_MS;
    else process.env.AIPASS_EDGE_WAITS_MS = saved;
  }
});

// What survives the waits is content: only then does the split come out. The
// old chain announced parts at every level, so a fragment that had to be split
// again carried "Part 1, more follows" stacked on the outer one — the garble
// the live sessions recorded. Announcing is the outermost split's job alone.
test('a nested split never stacks a second part prefix', async () => {
  const saved = process.env.AIPASS_EDGE_WAITS_MS;
  process.env.AIPASS_EDGE_WAITS_MS = '0';
  try {
    const sent = [];
    const say = async (t) => {
      if (t.includes('GAMMA') && Buffer.byteLength(t) > 400) throw new Error('aipass returned 403 Forbidden');
      sent.push(t);
      return 'ok';
    };
    const filler = 'a line of perfectly ordinary words that pads the message\n';
    const text = `GAMMA-ONE\n${filler.repeat(8)}GAMMA-TWO\n${filler.repeat(8)}`;
    await resilientSay(say, text, () => {});

    assert.ok(sent.length >= 2, 'the split continued where the refusal followed');
    assert.ok(sent.some((t) => /GAMMA-ONE/.test(t)), 'the fragments arrived');
    for (const t of sent) {
      const prefixes = (t.match(/Part 1, more follows/g) || []).length;
      assert.ok(prefixes <= 1, `a fragment carries at most one part prefix:\n${t.slice(0, 120)}`);
    }
  } finally {
    if (saved === undefined) delete process.env.AIPASS_EDGE_WAITS_MS;
    else process.env.AIPASS_EDGE_WAITS_MS = saved;
  }
});

/* The rate refusal at the message layer — waited again, never rewritten ----- */

// Recorded live, Oct 17 2026 (later the same day): the layered waits above
// were still not enough once a split had doubled the traffic. The part sends
// drew 429s, and the top layer had no rate branch at all — the run died with
// the raw 429 right after `rejected — splitting into 2 parts and resending`,
// the exact pair the report quoted. The message layer now waits rate refusals
// too (RATE_WAITS_MS again, above the client's own waits) and never lets one
// reach the rewrite chain: doubling the messages the edge is refusing is what
// keeps its limiter hot.
test('a 429 is waited again at the message layer, and never split', async () => {
  const saved = process.env.AIPASS_RATE_WAITS_MS;
  process.env.AIPASS_RATE_WAITS_MS = '5,5';
  try {
    const sent = [];
    const notes = [];
    let calls = 0;
    const say = async (t) => {
      sent.push(t);
      if (++calls <= 2) throw new Error('aipass returned 429  [2046 bytes] {server=cloudflare}');
      return 'ok';
    };
    const text = 'an ordinary tool result that drew a rate refusal\n'.repeat(8);
    await resilientSay(say, text, (_lvl, t) => notes.push(t));

    assert.equal(sent.length, 3, 'refused twice, accepted on the third attempt');
    assert.equal(sent[1], sent[0], 'every resend was the very same message');
    assert.equal(sent[2], sent[0]);
    assert.ok(notes.some((t) => /rate limited by the edge — waiting/.test(t)), 'the pause is reported as a note');
    assert.ok(!notes.some((t) => /splitting/.test(t)), 'a rate refusal never reaches the split');
    assert.ok(!notes.some((t) => /omitting/.test(t)), 'and nothing was dropped for it');
  } finally {
    if (saved === undefined) delete process.env.AIPASS_RATE_WAITS_MS;
    else process.env.AIPASS_RATE_WAITS_MS = saved;
  }
});

test('a 429 that never clears surfaces with advice, not as a rewrite', async () => {
  const saved = process.env.AIPASS_RATE_WAITS_MS;
  process.env.AIPASS_RATE_WAITS_MS = '0,0';
  try {
    const notes = [];
    let calls = 0;
    const say = async () => { calls++; throw new Error('aipass returned 429  [2046 bytes] {server=cloudflare}'); };
    await assert.rejects(
      () => resilientSay(say, 'anything at all', (_lvl, t) => notes.push(t)),
      (err) => {
        assert.match(err.message, /429/, 'the forensics survive');
        assert.match(err.message, /account is moving too fast/, 'and the advice is attached');
        return true;
      },
    );
    assert.equal(calls, 3, 'the first send plus both waits — then the failure is real');
    assert.ok(!notes.some((t) => /splitting|omitting/.test(t)), 'no rewrite was attempted for a rate refusal');
  } finally {
    if (saved === undefined) delete process.env.AIPASS_RATE_WAITS_MS;
    else process.env.AIPASS_RATE_WAITS_MS = saved;
  }
});

// The half-delivered refusal, at the message layer this time: retrySend marks
// `err.streamed` when it refuses to resend over a delivered answer, and the
// rewrite chain right above must honour the same mark — a redact or split
// there would send the message again and the answer would arrive twice.
test('a refusal marked streamed is not resent by the message layer', async () => {
  let calls = 0;
  const say = async () => {
    calls++;
    const err = new Error('aipass returned 403 Forbidden — after a half answer');
    err.streamed = true;
    throw err;
  };
  await assert.rejects(() => resilientSay(say, 'x'.repeat(500), () => {}), /403/);
  assert.equal(calls, 1, 'the refusal surfaced instead of a resend over the delivered half');
});
