#!/usr/bin/env node
// aipass desktop — the entry point the window (or the browser, until the
// Tauri shell exists) starts.
//
// It owns exactly two things:
//   1. the bridge, started if it is not already running, so nobody has to keep
//      a second terminal open for a logged-in browser tab
//   2. the harness backend (`/rpc` + `/events`), which the window talks to
//
// Everything else — sessions, permissions, diffs, compaction — is the harness's
// business, shared unchanged with `aipass agent`.
//
// The launcher's rules live in `aipass-bridge/harness/launcher.mjs`, so a test
// can drive them; this file only finds the code in whichever layout it was
// started from and hands the launcher what it needs.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * The content overlay: a promoted content tree, put there by the update
 * system from a pack whose hash is in a signed feed.
 *
 * It wins over the bundle and over the checkout — it is the newest thing a
 * person deliberately chose, and the only one of the three that was checked
 * against a signature. The rule is the harness's (`harness/app-root.mjs`);
 * the shell has its own copy (`src-tauri/src/main.rs`), and a test says the
 * two agree.
 *
 * The lookup is here, in plain fs, because this file has to know where the
 * bridge is BEFORE it can import anything from it.
 */
const overlayRoot = () => {
  try {
    const home = process.env.AIPASS_HOME?.trim() || path.join(os.homedir(), '.aipass');
    const active = JSON.parse(fs.readFileSync(path.join(home, 'app', 'active.json'), 'utf8'));
    const root = active?.current?.root;
    if (!root) return null;
    return fs.existsSync(path.join(root, 'aipass-bridge', 'bridge', 'server.mjs')) ? root : null;
  } catch {
    return null;
  }
};

// In the repo this file is desktop/main.mjs and aipass-bridge is a sibling of
// the repo root; the packaged layout ships it beside aipass-bridge/ instead.
const REPO = (() => {
  const overlay = overlayRoot();
  if (overlay) return overlay;
  return fs.existsSync(path.join(HERE, 'aipass-bridge', 'bridge', 'server.mjs')) ? HERE : path.resolve(HERE, '..');
})();
// A static relative import can only ever see one of the two layouts, so resolve
// the backend from REPO — `node main.mjs` then works from both.
const { createRpc, resolveBridgeURL } = await import(pathToFileURL(path.join(REPO, 'aipass-bridge', 'harness', 'rpc.mjs')));
// The launcher's rules, the same way: from REPO, so both layouts work.
const {
  runLauncher, resolveDesktopPort, resolveRoot, wantsDetach,
} = await import(pathToFileURL(path.join(REPO, 'aipass-bridge', 'harness', 'launcher.mjs')));

const PORT = resolveDesktopPort();
const ROOT = resolveRoot();
const BRIDGE_URL = resolveBridgeURL();

await runLauncher({
  repo: REPO,
  port: PORT,
  root: ROOT,
  bridgeUrl: BRIDGE_URL,
  createRpc,
  detach: wantsDetach(),
});
