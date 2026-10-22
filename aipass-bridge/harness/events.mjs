// @ts-check
// A tiny observer — the harness never calls console.log itself, so the same
// loop can print to a terminal, stream to a desktop window, or drive a test.
export class Emitter {
  constructor() { this.handlers = new Map(); }

  /**
   * @param {string} type
   * @param {(payload?: any) => void} fn
   * @returns {() => void}
   */
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }

  /** @param {string} type @param {(payload: any) => void} fn */
  off(type, fn) { this.handlers.get(type)?.delete(fn); }

  /**
   * @param {string} type
   * @param {any} [payload]
   */
  emit(type, payload = {}) {
    for (const fn of this.handlers.get(type) ?? []) {
      try { fn(payload); } catch { /* a listener must never break a run */ }
    }
    for (const fn of this.handlers.get('*') ?? []) {
      try { fn(type, payload); } catch { /* ditto */ }
    }
  }

  /** True when somebody is listening — a gate with no listener must not block.
   * @param {string} type */
  hasListeners(type) { return (this.handlers.get(type)?.size ?? 0) > 0; }

  /** Specific listener, or the wildcard one — both see the event.
   * @param {string} type */
  isObserved(type) { return this.hasListeners(type) || this.hasListeners('*'); }
}

/**
 * The most a subscriber's queue may hold, in frames and in bytes.
 *
 * Two bounds, like the replay buffer: a COUNT of frames and a BYTE budget.
 * The count is the memory backstop — a window that stopped reading for a
 * minute is thousands of small deltas — and the bytes keep one enormous tool
 * result from taking the whole budget on its own.
 */
export const FANOUT_FRAMES = 2000;
export const FANOUT_BYTES = 4 * 1024 * 1024;

/**
 * The notice a subscriber that fell behind is given.
 *
 * A NAMED frame, and one with no `id:` — the rule the ping follows: the
 * notice is not part of the replay stream, so a reconnect's Last-Event-ID
 * still points at the last real frame and the replay skips nothing.
 */
const behindFrame = (dropped) => `event: fell_behind\ndata: ${JSON.stringify({ dropped })}\n\n`;

/**
 * One subscriber: its sink, its queue, and what it has lost.
 *
 * The sink is a function that takes a frame and answers whether it is still
 * keeping up: false means the frame was taken but the sink is behind (a
 * socket whose buffer is full). The fan-out stops writing to it until the
 * caller says it can take more again (`flush()`).
 */
class Subscriber {
  /**
   * @param {(frame: string) => boolean} sink
   * @param {{frames: number, bytes: number}} limits
   */
  constructor(sink, { frames, bytes }) {
    this.sink = sink;
    this.frames = frames;
    this.bytes = bytes;
    this.queue = [];        // the frames the sink has not taken yet
    this.queuedBytes = 0;
    this.dropped = 0;       // the frames lost to the bound, since the start
    this.owed = false;      // a "you fell behind" notice is waiting to be sent
    this.ready = true;
    this.dead = false;
  }

  /** How many frames this subscriber is holding. */
  get pending() { return this.queue.length + (this.owed ? 1 : 0); }

  /**
   * One frame for this subscriber.
   *
   * The sink takes it while it can. When it cannot, the frame waits in the
   * queue — and when the queue is over its bound the OLDEST frames go: the
   * newest ones are the ones the window can still use, and the count of what
   * was lost is what the window has to be told.
   *
   * @param {string} frame
   * @returns {boolean} false when the subscriber is gone
   */
  push(frame) {
    if (this.dead) return false;
    if (this.ready) {
      let behind = false;
      try { behind = this.sink(frame) === false; } catch { this.dead = true; return false; }
      if (!behind) return true;
      // The sink took the frame and says it is behind: from here on nothing
      // is written until the caller flushes. The frame itself is not owed
      // again — the sink has it.
      this.ready = false;
      return true;
    }
    this.queue.push({ frame, size: Buffer.byteLength(frame) });
    this.queuedBytes += this.queue.at(-1).size;
    this.trim();
    return true;
  }

  /**
   * The bound, and the notice it earns.
   *
   * The oldest go first, and the count of what was lost is kept: a window
   * that comes back wants the run it is in, not the run it missed, and it has
   * to be told that something was.
   */
  trim() {
    while (this.queue.length > this.frames || (this.queuedBytes > this.bytes && this.queue.length > 1)) {
      const gone = this.queue.shift();
      this.queuedBytes -= gone.size;
      this.dropped += 1;
      this.owed = true;
    }
  }

  /**
   * Give the sink everything it can take.
   *
   * The notice goes FIRST: a window that reads a stream with a hole in it
   * and no idea that there was one reads it as a stream that never had those
   * frames.
   */
  flush() {
    if (this.dead) return;
    if (this.owed) {
      if (this.#write(behindFrame(this.dropped))) return; // still behind: the notice waits
      this.owed = false;
    }
    while (this.queue.length) {
      const head = this.queue[0];
      const behind = this.#write(head.frame);
      // The frame was taken by the sink either way — it is not owed again.
      // Leaving it in the queue when the sink is behind wrote it a second
      // time on the next flush, and the window saw the same frame twice.
      this.queuedBytes -= head.size;
      this.queue.shift();
      if (behind) return;
    }
  }

  /**
   * One write to the sink.
   *
   * @param {string} frame
   * @returns {boolean} true when the sink is behind
   */
  #write(frame) {
    try {
      const behind = this.sink(frame) === false;
      this.ready = !behind;
      return behind;
    } catch {
      // A sink whose window closed: nothing to write to any more.
      this.dead = true;
      return false;
    }
  }
}

/**
 * The fan-out to the windows, with a bound.
 *
 * Every window subscribes; every harness event is published to all of them.
 * The rule it holds: a subscriber that stops reading must not make the
 * backend's memory grow. The frames wait in a bounded queue, the oldest go
 * when it overflows, the losses are counted, and the subscriber is told it
 * fell behind — a named event the window can show as a notice.
 *
 * The replay buffer is a different thing and stays where it is: it is the
 * history a RECONNECTING window asks for, and its contract (monotonic
 * sequence numbers, no duplicate frame, `Last-Event-ID`) is unchanged.
 */
export class EventFanout {
  /**
   * @param {{frames?: number, bytes?: number}} [limits]
   */
  constructor({ frames = FANOUT_FRAMES, bytes = FANOUT_BYTES } = {}) {
    this.frames = frames;
    this.bytes = bytes;
    this.subscribers = new Set();
  }

  /**
   * One subscriber. The handle is what the caller flushes when its sink
   * drains.
   *
   * @param {(frame: string) => boolean} sink
   */
  subscribe(sink) {
    const sub = new Subscriber(sink, { frames: this.frames, bytes: this.bytes });
    this.subscribers.add(sub);
    return sub;
  }

  /** Take a subscriber away — its window closed. */
  unsubscribe(sub) { this.subscribers.delete(sub); }

  /** One frame to every subscriber. */
  publish(frame) {
    for (const sub of [...this.subscribers]) {
      if (!sub.push(frame) && sub.dead) this.subscribers.delete(sub);
    }
  }

  /** What the fan-out holds, and what it has lost. */
  stats() {
    let queued = 0;
    let bytes = 0;
    let dropped = 0;
    let owed = 0;
    for (const sub of this.subscribers) {
      queued += sub.queue.length;
      bytes += sub.queuedBytes;
      dropped += sub.dropped;
      owed += sub.owed ? 1 : 0;
    }
    return { subscribers: this.subscribers.size, queued, bytes, dropped, owed };
  }
}
