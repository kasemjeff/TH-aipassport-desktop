// The second axis of a RUN: not "against which tree" (execution.mjs owns
// that) but "with which rights". A command's tree and its rights are two
// different questions, and answering them in one module would make either
// one impossible to test or swap without the other.
//
// This module is the seam. Behind it sit the platform backends (Seatbelt,
// bubblewrap, a Windows helper, or 'none'), and in front of it sit the
// RUN/VERIFY/JOBS tools, which learn one option (`sandbox`) and never which
// backend is answering. A module that has one adapter is a hypothetical
// seam; this one has at least two (a real backend and 'none', plus 'fake'
// for tests), so it earns its keep.
//
// Fail closed is the rule: a sandbox mode that cannot be enforced is
// refused, never silently downgraded to "run anyway". A downgrade is the
// one thing this project does not ship.
import { platform } from 'node:os';

/** The sandbox modes a run may be given. */
export const SANDBOX_MODES = Object.freeze(['off', 'read-only', 'workspace-write', 'danger-full-access']);

/** Which backend this platform can offer today. Phase 1 ships none: the real
 *  backends (Seatbelt, bubblewrap, a Windows helper) land in later waves.
 *  Keeping this a function means the adapters are added here and nowhere else. */
export function backendFor(p = platform()) {
  if (p === 'darwin') return 'none'; // seatbelt lands in wave B2
  if (p === 'linux') return 'none';  // bubblewrap lands in wave B2
  if (p === 'win32') return 'none';  // the Windows helper lands in wave E
  return 'none';
}

/** Resolve the policy for one run. Pure: no I/O, no spawn, so it is tested
 *  without an OS. `backend` may be injected by a test; otherwise it is
 *  derived from the platform. */
export function resolvePolicy({ sandboxMode = 'off', platform: p = platform(), backend = null, allowHosts = [] } = {}) {
  const b = backend ?? backendFor(p);
  const mode = SANDBOX_MODES.includes(sandboxMode) ? sandboxMode : 'off';
  // 'off' and 'danger-full-access' carry no boundary: the command runs with
  // the person's rights, exactly as it did before this module existed.
  if (mode === 'off' || mode === 'danger-full-access') {
    return {
      sandboxMode: mode, backend: b, refuse: null,
      fs: 'none', needsProjection: false,
      net: { mode: 'off', hosts: [] },
      danger: mode === 'danger-full-access',
    };
  }
  // A mode that needs enforcing but has no backend is a refusal, not a
  // silent run. This is the whole point of the row.
  if (b === 'none') {
    return {
      sandboxMode: mode, backend: b,
      refuse: `the sandbox backend is not available on ${p} — the command was not run. Set sandbox: danger-full-access to run it without one.`,
      fs: 'none', needsProjection: false,
      net: { mode: 'off', hosts: [] },
      danger: false,
    };
  }
  // Real backend (future waves): the policy the backends honour.
  if (mode === 'read-only') {
    return {
      sandboxMode: mode, backend: b, refuse: null,
      fs: 'read', needsProjection: false,
      net: { mode: 'off', hosts: [] },
      danger: false,
    };
  }
  // workspace-write
  return {
    sandboxMode: mode, backend: b, refuse: null,
    fs: 'write', needsProjection: true,
    net: { mode: allowHosts.length ? 'allowlist' : 'off', hosts: [...allowHosts] },
    danger: false,
  };
}

/** Build the adapter a tool will call. `runShell` is the today's runner; a
 *  real backend replaces it. The adapter's interface is the only thing the
 *  tools learn. */
export function makeBoundary(policy, { runShell, projectionRoot = null, tempRoot = null } = {}) {
  const refuse = policy.refuse;
  const passthrough = (command, opts) => runShell(command, opts);

  return {
    mode: policy.sandboxMode,
    backend: policy.backend,
    available: () => ({ ok: !refuse && (policy.sandboxMode === 'off' || policy.sandboxMode === 'danger-full-access' || policy.backend !== 'none'), reason: refuse }),
    // `run` answers with the same shape runShell does: {stdout,stderr} or a
    // thrown Error carrying code/signal/stdout/stderr. A refusal is returned
    // as an `err:` string so the model reads what happened.
    async run(command, opts = {}) {
      if (refuse) return { __refused: true, message: `err: ${refuse}` };
      // Phase 1 has no enforcing backend; the only non-refusing modes are
      // 'off' and 'danger-full-access', both of which are passthrough.
      return passthrough(command, opts);
    },
  };
}

/** Convenience: resolve + build in one call, for the tools. */
export function boundaryFor({ sandboxMode, platform: p, backend, allowHosts, runShell, projectionRoot, tempRoot } = {}) {
  const policy = resolvePolicy({ sandboxMode, platform: p, backend, allowHosts });
  return { policy, boundary: makeBoundary(policy, { runShell, projectionRoot, tempRoot }) };
}
