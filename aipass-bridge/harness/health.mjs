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
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const answer = health();
  process.stdout.write(`${JSON.stringify(answer)}\n`);
  process.exit(answer.ok ? 0 : 1);
}
