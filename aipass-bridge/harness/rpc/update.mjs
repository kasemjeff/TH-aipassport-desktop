// The update domain: what is out there, and the one way it may be put in
// place.
//
// The backend does the fetching, not the page: the window is served under a
// policy that allows the loopback and nothing else, and the keyring is the
// backend's business anyway. A machine that is offline gets the cached feed or
// nothing — and nothing is nagged.
//
// An update is a verified thing, never a downloaded one (docs/UPDATE_DESIGN.md):
// the feed is signed, the artifact is checked against that feed, and the
// content is replaced only when a person asks for it and no run is in flight.
import fs from 'node:fs';
import path from 'node:path';
import {
  downloadVerified,
  promote,
  refuseWhileRunning,
  refuseUnsignedArtifact,
  rollback as rollbackContent,
  updateState,
} from '../update.mjs';
import { aipassHome } from '../settings.mjs';
import { commandsDir, installCommandFile } from '../app-root.mjs';
import { writeFileAtomic } from '../atomic-write.mjs';

/**
 * The exit code that means "restart me on purpose". The shell reads it as a
 * deliberate restart — a new content tree needs a new backend — and not as a
 * crash to answer with backoff.
 */
export const RESTART_EXIT = 42;

/**
 * The update methods of the backend.
 *
 * @param {import('./context.mjs').RpcContext} ctx the shared backend state
 */
export function createUpdateMethods(ctx) {
  const {
    staged,
    targetFor,
    checkForUpdates,
  } = ctx;

  return {

    /* --------------------------------------------------------------- updates */

    /**
     * What is out there.
     *
     * The backend does the fetching, not the page: the window is served
     * under a policy that allows the loopback and nothing else, and the
     * keyring is the backend's business. A machine that is offline gets the
     * cached feed or nothing — and nothing is nagged.
     */
    async 'update.check'(params = {}) {
      return checkForUpdates({ force: params.force === true });
    },

    /**
     * Put a new content tree in place.
     *
     * A run in flight refuses it: the harness is in memory, and swapping the
     * files under a running turn is how a half-applied state becomes a
     * mystery. The window offers it again when the run ends.
     *
     * The steps are the service's: check, download, verify, promote. The
     * promotion is atomic, so a failure anywhere leaves the content that was
     * running exactly where it was.
     */
    async 'update.apply'(params = {}) {
      const h = targetFor(params);
      const refused = refuseWhileRunning(h.running);
      if (refused) return refused;
      const found = await checkForUpdates({ force: true });
      const release = found?.available?.content;
      if (!release) {
        return { ok: false, reason: found?.reason ?? 'there is no new content to install' };
      }
      const fetched = await downloadVerified(release, { home: aipassHome() });
      if (!fetched.ok) return fetched;
      const promoted = await promote(fetched.file, {
        home: aipassHome(),
        // The probe runs on the app's own Node, so the staged tree is tested
        // with the runtime that will run it.
        nodePath: process.execPath,
      });
      if (!promoted.ok) return promoted;
      if (params.restart !== false) {
        // The new content needs a NEW backend to run it: this process holds
        // the old modules in memory. The exit code says "restart me on
        // purpose", so the shell does not read it as a crash — and the
        // window waits for the backend to come back before it reloads.
        setTimeout(() => process.exit(RESTART_EXIT), 500);
      }
      // The answer says what was scheduled, not what was asked for: a caller
      // that asked for no restart gets no restart, and one that waits for the
      // backend to come back must not wait for a restart that was never set.
      return { ...promoted, restart: params.restart !== false, previous: found.current?.content ?? null };
    },

    /**
     * Hand the app over to the installer.
     *
     * The shell — the binary — is replaced by the installer, and a running
     * binary is locked on Windows: the app has to be closed for the
     * installer to do its work. So the backend verifies the artifact against
     * the signed feed, puts it where the shell looks for it, and leaves a
     * command; the shell, which outlives the backend, reads the command and
     * does the handover.
     *
     * The handover is REFUSED for an unsigned installer, and the gate is the
     * signed feed's own word about the artifact — so only the release key
     * can open it. The Windows installer is unsigned today, so this path is
     * closed until it is not.
     */
    async 'update.install'(params = {}) {
      const h = targetFor(params);
      const refused = refuseWhileRunning(h.running);
      if (refused) return refused;
      if (process.platform !== 'win32') {
        return {
          ok: false,
          reason: `the handover is Windows-only — on ${process.platform} the installer is the system's own`,
        };
      }
      const found = await checkForUpdates({ force: true });
      const release = found?.available?.shell;
      if (!release) {
        return { ok: false, reason: found?.reason ?? 'there is no new installer to hand over to' };
      }
      const unsigned = refuseUnsignedArtifact(release);
      if (unsigned) return unsigned;
      const fetched = await downloadVerified(release, { home: aipassHome() });
      if (!fetched.ok) return fetched;
      const command = {
        version: release.version,
        // A NAME, not a path: the shell builds the path itself, from its own
        // downloads directory, so a command file cannot make the app run
        // anything anywhere else.
        file: path.basename(String(release.file)),
        sha256: release.sha256,
        kind: release.kind ?? 'nsis',
        at: Date.now(),
      };
      const dir = commandsDir(aipassHome());
      await fs.promises.mkdir(dir, { recursive: true });
      writeFileAtomic(installCommandFile(aipassHome()), `${JSON.stringify(command, null, 2)}\n`);
      return { ok: true, version: release.version, file: fetched.file, handover: true };
    },

    /**
     * Go back to the previous content tree.
     *
     * The previous tree was kept when the current one was promoted, so this
     * needs neither the network nor the pack.
     */
    async 'update.rollback'(params = {}) {
      return rollbackContent({ home: aipassHome() });
    },

    /** What the app knows about its own update state. */
    async 'update.state'(params = {}) {
      return updateState({ home: aipassHome() });
    },
  };
}

export default createUpdateMethods;
