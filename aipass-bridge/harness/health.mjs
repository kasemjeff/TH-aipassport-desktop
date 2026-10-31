// @ts-check
// The loadability probe.
//
// The update smoke test runs this against a STAGED content tree, in its own
// process, before the tree is promoted: a tree whose modules cannot be
// imported is never promoted, so a broken release is caught before it is
// live rather than after.
//
// It imports the modules the backend needs first, so the probe fails when
// the tree's module graph is broken — not only when this file is. A pack
// that lost a file, or whose files disagree with each other, fails here.
//
// It is deliberately dependency-light: the probe's own imports are the ones
// it is testing, so a tree that cannot load them cannot report that it
// cannot load them.
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULTS } from './settings.mjs';
import { APP_VERSION } from './session.mjs';

/** The probe's answer. `ok` is the only field that decides a promotion. */
export function health() {
  return {
    ok: true,
    version: APP_VERSION ?? null,
    settings: Boolean(DEFAULTS),
  };
}

// Run as a script, it answers on stdout — which is how the smoke test runs
// it. The same trick the build scripts use to tell "imported" from "ran".
// The comparison is on the real path: a staged tree may be reached through a
// link (`/var` on macOS is `/private/var`; Windows has short names), and the
// two spellings of one file are the same script. Comparing the lexical names
// made the probe silent through a link, so the promotion refused a good tree.
/** @param {string} file */
const realpath = (file) => {
  try {
    return fs.realpathSync.native?.(file) ?? fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
};
const isMain = Boolean(process.argv[1])
  && realpath(process.argv[1]) === realpath(fileURLToPath(import.meta.url));
if (isMain) {
  const answer = health();
  process.stdout.write(`${JSON.stringify(answer)}\n`);
  process.exit(answer.ok ? 0 : 1);
}
