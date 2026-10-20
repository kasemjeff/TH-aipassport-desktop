// Log files that cannot grow without bound.
//
// bridge.log and desktop-backend.log are opened append-only and written for
// the life of a machine: a bridge left running for weeks used to mean a log
// that grows to megabytes with nothing ever trimming it. Size-capped rotation
// keeps one previous generation (<name>.1) — enough to see the crash that
// filled the file, without an unbounded pile.
import fs from 'node:fs';
import path from 'node:path';

export const LOG_MAX_BYTES = Number(process.env.AIPASS_LOG_MAX_BYTES ?? 5 * 1024 * 1024);

/**
 * Open a log file for appending, rotating it first when it is over the cap.
 *
 * Returns an fd (as fs.openSync would). Rotation failures are swallowed: a
 * still-open handle on Windows, a read-only directory — none of them should
 * stop the process from logging; appending to the big file is the lesser evil.
 */
export function openLogFile(file, { maxBytes = LOG_MAX_BYTES } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.statSync(file).size > maxBytes) {
      const prev = `${file}.1`;
      // rename does not replace on Windows, and a stale .1 from last rotation
      // would make the rename itself fail.
      try { fs.rmSync(prev, { force: true }); } catch { /* held — try anyway */ }
      fs.renameSync(file, prev);
    }
  } catch { /* no file yet, or another process holds it — append instead */ }
  return fs.openSync(file, 'a');
}
