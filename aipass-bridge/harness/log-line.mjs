// One line per event: for humans by default, for machines when asked.
//
// The real trace of a run is the session JSONL (ids, steps, every tool call)
// and the SSE event stream (seq numbers) — the log line only has to carry the
// time, the level, and, when there is one, the short request id that ties a
// line back to the HTTP exchange it came from. `AIPASS_LOG_FORMAT=json` turns
// the same call into one JSON object per line for anything that collects logs.
const LOG_FORMAT = 'AIPASS_LOG_FORMAT';

/** One formatted log line (no trailing newline). */
export function formatLogLine({ ts = Date.now(), level = 'info', msg = '', rid = null } = {}) {
  const at = new Date(ts).toISOString();
  const text = String(msg);
  if ((process.env[LOG_FORMAT] ?? 'text').toLowerCase() === 'json') {
    return JSON.stringify({ ts: at, level, ...(rid ? { rid } : {}), msg: text });
  }
  const stamp = at.slice(11, 19); // HH:MM:SS
  const tag = level === 'info' ? '' : ` ${String(level).toUpperCase()}`;
  const req = rid ? ` [${rid}]` : '';
  return `${stamp}${tag}${req} ${text}`;
}

/** A short id for one request — small enough to read off a screen. */
export function requestId() {
  return Math.random().toString(16).slice(2, 8);
}
