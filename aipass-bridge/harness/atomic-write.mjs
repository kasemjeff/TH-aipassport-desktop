// One crash-safe swap, shared by the stores that need it.
//
// Write the new bytes to a sibling temp file, pin its mode, then rename it
// over the destination: rename replaces an existing destination on both
// platforms (libuv uses MoveFileEx with MOVEFILE_REPLACE_EXISTING on Windows),
// so a crash at any point leaves either the previous version or the complete
// new one — never a half-written file. Session files (session.mjs), applied
// edits (overlay.mjs), permission rules (rules.mjs) and the memory store
// (memory-store.mjs) all ride this. settings.json and the provider registry
// ride it too — they used to carry their own inline copies of the same three
// lines, and a second copy of a swap is a second copy that can disagree with
// the first about what "atomic" means.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Owner-only where the OS has POSIX modes; Windows keeps ACLs, so the chmod is
// best effort there. The stores are the sensitive data class (SECURITY.md).
export function tighten(target, mode) {
  try { fs.chmodSync(target, mode); } catch { /* best effort on Windows */ }
}

/**
 * A temp name no other writer shares.
 *
 * The name used to be `${file}.tmp` — one name for the whole machine. Two
 * writers (the desktop backend's `settings.set` and a CLI command) then
 * fought over it: the second truncated the bytes the first had written, the
 * first's rename moved the file out from under the second, and the second's
 * rename failed with ENOENT — an error that surfaced as a lost update, with
 * the in-memory state left stale behind it.
 *
 * The pid, a counter and a random suffix make the name unique per write, so
 * two writers never meet; the random part also means the name cannot be
 * guessed by another local user on a shared machine.
 */
let counter = 0;
const tempPath = (file) => `${file}.${process.pid}.${counter += 1}.${crypto.randomBytes(4).toString('hex')}.tmp`;

/**
 * The parent directory's entry must be durable too: the rename is a change
 * to the directory, and a power cut can lose it even when the file's bytes
 * are safe on the disk.
 *
 * Windows cannot open a directory as a file (and journals the rename
 * itself), so the fsync is a POSIX-only step.
 */
const syncDir = (dir) => {
  if (process.platform === 'win32') return;
  let fd = null;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Best effort: a filesystem that will not fsync a directory still renames
    // atomically, which is the property this module promises first.
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
  }
};

/**
 * A synchronous pause, for the retry below.
 *
 * The swap is a sync call from sync call sites, so the wait has to be a sync
 * wait: `Atomics.wait` is the one Node offers, and it is the one that does
 * not spin the CPU. A runtime that will not give out a SharedArrayBuffer
 * simply retries without a pause.
 */
const sleeper = (() => {
  try { return new Int32Array(new SharedArrayBuffer(4)); } catch { return null; }
})();
const pause = (ms) => {
  if (!sleeper) return;
  try { Atomics.wait(sleeper, 0, 0, ms); } catch { /* not allowed on this thread */ }
};

/**
 * A synchronous pause, in milliseconds.
 *
 * The store that locks a file has to wait for the lock without giving up the
 * thread it is on: a session header is written from a synchronous call site
 * (an append), and an `await` there would mean every caller had to become
 * async. `Atomics.wait` is the one wait Node offers that does not spin the
 * CPU, and a runtime without a SharedArrayBuffer simply does not wait.
 *
 * @param {number} ms
 */
export const sleepSync = (ms) => pause(ms);

/**
 * The swap, tried again when the platform says "not right now".
 *
 * On Windows a rename onto a file that is being replaced at the same moment
 * fails with EPERM (ERROR_ACCESS_DENIED): MoveFileEx cannot take the
 * destination away while another process is putting its own there. Nothing
 * is lost and the bytes are not wrong — the swap simply has to be tried
 * again a moment later. Without the retry, two writers of one file lose one
 * of the two writes to a platform quirk.
 */
const renameWithRetry = (from, to) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const transient = err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'EACCES';
      if (!transient || attempt >= 3) throw err;
      pause((attempt + 1) * 5);
    }
  }
};

/**
 * Replace `file` with `text`, atomically. `mode` (when given) is pinned on the
 * new file before the swap — POSIX only, a no-op on Windows. An existing
 * file's mode is NOT inherited: callers that need to preserve one (an applied
 * edit keeping a script executable) read it themselves and pass it here.
 *
 * `temp` names the file the bytes land in before the swap. It is unique per
 * write by default; a caller passes one only when it must know where the
 * bytes go (a test that plants a symlink there).
 */
export function writeFileAtomic(file, text, { mode = null, temp = null } = {}) {
  const tmp = temp ?? tempPath(file);
  let fd = null;
  // Only a temp file this call created may be cleaned up afterwards: a name
  // that was already there belongs to somebody else.
  let ours = false;
  try {
    // 'wx' is O_CREAT|O_EXCL: the temp file must not exist yet. A name a
    // crashed run left behind, or one another local user planted as a
    // symlink, is a clean failure here instead of a silent write THROUGH it
    // — writeFileSync follows symlinks and truncates whatever they point at.
    fd = mode === null ? fs.openSync(tmp, 'wx') : fs.openSync(tmp, 'wx', mode);
    ours = true;
    fs.writeFileSync(fd, text);
    // The bytes have to be on the disk before the name that points at them
    // is swapped: a rename is atomic against a PROCESS crash, not against a
    // power cut, and only an fsync makes the data durable.
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    // A `mode` only applies when the file is created, and the umask takes
    // bits off it, so the mode is pinned after the write.
    if (mode !== null) tighten(tmp, mode);
    renameWithRetry(tmp, file);
    ours = false; // the temp name is the destination now; nothing to clean up
    // The swap itself is a change to the directory, and it has to be durable
    // for the same reason the bytes are.
    syncDir(path.dirname(file));
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* already closed */ } }
    // A failed write leaves nothing behind.
    if (ours) { try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ } }
  }
}
