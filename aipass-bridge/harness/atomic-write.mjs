// One crash-safe swap, shared by the stores that need it.
//
// Write the new bytes to a sibling temp file, pin its mode, then rename it
// over the destination: rename replaces an existing destination on both
// platforms (libuv uses MoveFileEx with MOVEFILE_REPLACE_EXISTING on Windows),
// so a crash at any point leaves either the previous version or the complete
// new one â€” never a half-written file. Session files (session.mjs), applied
// edits (overlay.mjs), permission rules (rules.mjs) and the memory store
// (memory-store.mjs) all ride this. settings.json, mcp.json and the plugin
// registry have their own inline copies of the same three lines; they predate
// this module and are left alone rather than churned.
import fs from 'node:fs';

// Owner-only where the OS has POSIX modes; Windows keeps ACLs, so the chmod is
// best effort there. The stores are the sensitive data class (SECURITY.md).
export function tighten(target, mode) {
  try { fs.chmodSync(target, mode); } catch { /* best effort on Windows */ }
}

/**
 * Replace `file` with `text`, atomically. `mode` (when given) is pinned on the
 * new file before the swap â€” POSIX only, a no-op on Windows. An existing
 * file's mode is NOT inherited: callers that need to preserve one (an applied
 * edit keeping a script executable) read it themselves and pass it here.
 */
export function writeFileAtomic(file, text, { mode = null } = {}) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, mode === null ? undefined : { mode });
  if (mode !== null) tighten(tmp, mode);
  fs.renameSync(tmp, file);
}
