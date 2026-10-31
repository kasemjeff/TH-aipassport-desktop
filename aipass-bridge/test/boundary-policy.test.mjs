import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePolicy, backendFor, SANDBOX_MODES } from '../harness/boundary.mjs';

test('SANDBOX_MODES lists the four modes', () => {
  assert.deepEqual(SANDBOX_MODES, ['off', 'read-only', 'workspace-write', 'danger-full-access']);
});

test('off and danger-full-access carry no boundary and never refuse', () => {
  for (const mode of ['off', 'danger-full-access']) {
    const p = resolvePolicy({ sandboxMode: mode, backend: 'none' });
    assert.equal(p.refuse, null, mode);
    assert.equal(p.fs, 'none', mode);
    assert.equal(p.needsProjection, false, mode);
  }
});

test('a mode that needs enforcing refuses when there is no backend', () => {
  for (const mode of ['read-only', 'workspace-write']) {
    const p = resolvePolicy({ sandboxMode: mode, platform: 'win32', backend: 'none' });
    assert.ok(p.refuse, mode);
    assert.match(p.refuse, /not available/);
    assert.match(p.refuse, /danger-full-access/);
  }
});

test('a missing backend is never silently downgraded to a run', () => {
  const p = resolvePolicy({ sandboxMode: 'workspace-write', backend: 'none' });
  assert.equal(p.backend, 'none');
  assert.ok(p.refuse);
  // the policy does not claim it enforced anything
  assert.equal(p.fs, 'none');
});

test('an unknown mode becomes off, not a refusal and not a run', () => {
  const p = resolvePolicy({ sandboxMode: 'bogus', backend: 'none' });
  assert.equal(p.sandboxMode, 'off');
  assert.equal(p.refuse, null);
});

test('backendFor returns none on every platform in phase 1', () => {
  for (const p of ['darwin', 'linux', 'win32', 'freebsd']) {
    assert.equal(backendFor(p), 'none');
  }
});

test('workspace-write with a real backend needs a projection and an allowlist', () => {
  const p = resolvePolicy({ sandboxMode: 'workspace-write', backend: 'seatbelt', allowHosts: ['example.com'] });
  assert.equal(p.refuse, null);
  assert.equal(p.fs, 'write');
  assert.equal(p.needsProjection, true);
  assert.equal(p.net.mode, 'allowlist');
  assert.deepEqual(p.net.hosts, ['example.com']);
});

test('read-only with a real backend writes nothing and uses no network', () => {
  const p = resolvePolicy({ sandboxMode: 'read-only', backend: 'bubblewrap' });
  assert.equal(p.refuse, null);
  assert.equal(p.fs, 'read');
  assert.equal(p.needsProjection, false);
  assert.equal(p.net.mode, 'off');
});