// The environment the suite runs in.
//
// The suite must not touch the machine it runs on: the developer's own
// ~/.aipass, the developer's own bridge port, the developer's own browser.
// Every one of those is named here, so the suite and the coverage gate put
// the tests in the same place — a test that behaves differently under the
// gate is a test that measures nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

/** A port the OS hands out and nobody else claims. */
export async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * The scratch space a run uses, and the environment that points at it.
 *
 * Four things are named: the state home (settings, sessions, plugins, logs),
 * the bridge port, the browser profile and the browser pid file. A caller that
 * already set one of them wins — the suite is runnable under a real home on
 * purpose, and a caller that steers one of these steers it for the gate too.
 */
export async function suiteEnv({ home = null, browserProfile = null, browserPidFile = null, bridgePidFile = null } = {}) {
  const HOME = home ?? (process.env.AIPASS_HOME?.trim() || fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-suite-home-')));
  const BROWSER_HOME = browserProfile
    ? path.dirname(browserProfile)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-suite-browser-'));
  const PROFILE = browserProfile ?? path.join(BROWSER_HOME, 'profile');
  const PIDS = browserPidFile ?? path.join(BROWSER_HOME, 'pids.txt');
  // The bridge the suite starts is a BACKGROUND process, detached, so it
  // outlives the run that started it. It is also shared: the suite has one
  // bridge port, so there is one bridge, and every test file talks to it.
  //
  // So its pid file is the suite's, not the home's: a file in a test file's
  // own home would be missed by the cleanup that ends it, and a file in the
  // shared home would be missed by the per-file cleanup that must NOT end
  // it — that one would take the suite's bridge away while the other files
  // are still using it. The suite ends the bridge itself, once, at the end.
  const BRIDGE_PIDS = bridgePidFile ?? path.join(BROWSER_HOME, 'bridge.pid');
  const PORT = process.env.AIPASS_PORT?.trim() || String(await freePort());
  return {
    home: HOME,
    browserHome: BROWSER_HOME,
    browserProfile: PROFILE,
    browserPidFile: PIDS,
    bridgePidFile: BRIDGE_PIDS,
    bridgePort: PORT,
    env: {
      ...process.env,
      AIPASS_HOME: HOME,
      AIPASS_PORT: PORT,
      AIPASS_BRIDGE_PIDFILE: BRIDGE_PIDS,
      // The token bucket in BridgeClient paces real sends at nine per four
      // minutes; the suite's bridges are loopback fakes and must not pay that
      // wall clock. A test that pins the bucket passes an explicit
      // `rateBucket` option, so this floor never hides the production
      // default from tests.
      AIPASS_RATE_BUCKET: process.env.AIPASS_RATE_BUCKET ?? 'off',
      // The suite's own browser, always: the profile and the pid file are the
      // suite's business, and a caller that inherited somebody else's would
      // make the suite close a browser it did not open.
      AIPASS_BROWSER_PROFILE: PROFILE,
      AIPASS_BROWSER_PIDFILE: PIDS,
    },
  };
}
