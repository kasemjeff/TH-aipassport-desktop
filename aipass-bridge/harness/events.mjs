// A tiny observer — the harness never calls console.log itself, so the same
// loop can print to a terminal, stream to a desktop window, or drive a test.
export class Emitter {
  constructor() { this.handlers = new Map(); }

  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) { this.handlers.get(type)?.delete(fn); }

  emit(type, payload = {}) {
    for (const fn of this.handlers.get(type) ?? []) {
      try { fn(payload); } catch { /* a listener must never break a run */ }
    }
    for (const fn of this.handlers.get('*') ?? []) {
      try { fn(type, payload); } catch { /* ditto */ }
    }
  }

  /** True when somebody is listening — a gate with no listener must not block. */
  hasListeners(type) { return (this.handlers.get(type)?.size ?? 0) > 0; }

  /** Specific listener, or the wildcard one — both see the event. */
  isObserved(type) { return this.hasListeners(type) || this.hasListeners('*'); }
}
