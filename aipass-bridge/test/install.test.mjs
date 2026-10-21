// The installer, pinned. The design is docs/PLUGINS_MCP_DESIGN.md; these tests
// hold its four promises:
//   - plan and inspect run no plugin code — validation is the first execution,
//     and it happens only inside install, after the caller asked the person
//   - a failure anywhere leaves the previous version exactly where it was
//   - a replaced or removed plugin moves to .trash; nothing is deleted
//   - the registry is provenance: deleting it never blocks loading
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { tempDir } from './harness.mjs';
import {
  planInstall, inspectSource, installSource, finalizeInstall, removePlugin,
  readRegistry, decorateDetails, materializeEnabledList, stripFromEnabled, knownNames, NONE_NAME, updateSourceFor,
  copyTreeBounded,
} from '../harness/install.mjs';
import { PluginManager } from '../harness/plugins.mjs';

const pluginFile = (name, extra = '') => `
export default {
  name: '${name}',
  version: '1.0.0',
  description: 'installed in a test',
  setup(ctx) { ctx.tools.register('${name.toUpperCase().replace(/[^A-Z0-9_-]/g, '_')}_TOOL', () => 'ok'); ${extra} },
};
`;

/** A plugin that registers no marker — for names a marker cannot spell. */
const namedPlugin = (name) => `
export default {
  name: '${name}',
  version: '1.0.0',
  description: 'a plugin whose name is the point',
  setup(ctx) { ctx.log('loaded'); },
};
`;

/** A real loader for the temp home's plugins dir. */
const managerFor = (home) => new PluginManager({ dir: path.join(home, 'plugins'), settings: null, log: () => {} });

/** A loopback http host serving whatever `state.body` currently holds. */
async function serve(t, initial = '') {
  const state = { body: initial };
  const server = http.createServer((_req, res) => {
    res.setHeader('content-type', 'text/javascript');
    res.end(state.body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { state, url: `http://127.0.0.1:${server.address().port}/plugin.mjs` };
}

/**
 * A host that streams a body in chunks and declares no length.
 *
 * The cap has to hold while the body streams: a server that omits
 * `content-length` could otherwise push an unbounded body into the heap
 * before anything noticed. `state.sent` counts the bytes handed to the
 * socket, so the test can see that the transfer stopped early.
 */
async function serveStreamed(t, { chunk = 256 * 1024, count = 32, gapMs = 20 } = {}) {
  const state = { sent: 0, declared: null, stopped: false };
  const server = http.createServer((_req, res) => {
    res.on('error', () => { state.stopped = true; });
    res.writeHead(200, { 'content-type': 'text/javascript' });
    state.declared = res.getHeader('content-length') ?? null;
    const body = 'x'.repeat(chunk);
    let n = 0;
    const write = () => {
      if (state.stopped || res.destroyed) return;
      if (n++ >= count) { res.end(); return; }
      state.sent += chunk;
      res.write(body);
      setTimeout(write, gapMs);
    };
    write();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return { state, url: `http://127.0.0.1:${server.address().port}/plugin.mjs` };
}

/** A host that answers one path with a redirect to another. */
async function serveRedirect(t, from, to) {
  const server = http.createServer((req, res) => {
    if (req.url === from) {
      res.writeHead(302, { location: to });
      res.end();
      return;
    }
    res.setHeader('content-type', 'text/javascript');
    res.end(pluginFile('redirected'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  return `http://127.0.0.1:${server.address().port}${from}`;
}

test('plan names what it refuses, and touches nothing doing it', () => {
  assert.throws(() => planInstall(''), /no source given/);
  assert.throws(() => planInstall('ftp://example.com/x.mjs'), /unsupported scheme/);
  assert.throws(() => planInstall('http://example.com/plugin.mjs'), /http:\/\/ is refused/);

  // The one plain-http exception: a loopback host, named so tests can serve.
  assert.equal(planInstall('http://127.0.0.1:8799/x.mjs').kind, 'url');
  assert.equal(planInstall('http://localhost:8799/x.mjs').kind, 'url');

  const rel = planInstall('notes.mjs', { base: process.cwd() });
  assert.equal(rel.kind, 'path');
  assert.equal(rel.ref, path.resolve(process.cwd(), 'notes.mjs'));

  const home = planInstall('~/plugins/notes.mjs');
  assert.equal(home.kind, 'path');
  assert.ok(home.ref.startsWith(os.homedir()), '~ expands to the home directory');
});

test('a git or npm source is named, not refused', () => {
  // These used to be refused outright ("not installed yet"). They are fetched
  // by a tool instead of read from disk — and fetching is not running.
  const npm = planInstall('npm:some-plugin');
  assert.equal(npm.kind, 'npm');
  assert.equal(npm.pkg, 'some-plugin');
  assert.equal(npm.version, null);

  const scoped = planInstall('npm:@scope/pkg@1.2.3');
  assert.equal(scoped.pkg, '@scope/pkg', 'the scope is not the version');
  assert.equal(scoped.version, '1.2.3');

  const gh = planInstall('github:acme/plugins');
  assert.equal(gh.kind, 'git');
  assert.equal(gh.url, 'https://github.com/acme/plugins.git');
  assert.equal(gh.rev, null);

  const pinned = planInstall('github:acme/plugins#main');
  assert.equal(pinned.rev, 'main');

  const sub = planInstall('github:acme/plugins#main::path:packages/one');
  assert.equal(sub.subdir, 'packages/one', 'the sub-folder of the repository is kept');

  const remote = planInstall('git+ssh://git@github.com/acme/plugin.git#main');
  assert.equal(remote.url, 'ssh://git@github.com/acme/plugin.git', 'the git+ marker is the transport, not part of the url');
  assert.equal(remote.rev, 'main');

  assert.throws(() => planInstall('git+not-a-url'), /not a git source/);
  assert.throws(() => planInstall('github:noowner'), /not a github source/);
});

test('a git source that would travel over cleartext is refused', () => {
  // The message used to name a set the code did not enforce: `git+http://`
  // was accepted by the pattern while the message said https or ssh. A
  // plain link can be rewritten in transit, and git would follow it.
  assert.throws(() => planInstall('git+http://example.com/x.git'), /not a git source/);
  assert.throws(() => planInstall('git+http://example.com/x.git'), /git\+http:\/\/ is refused/);
  assert.throws(() => planInstall('git+git://example.com/x.git'), /not a git source/);

  // The documented set still works.
  assert.equal(planInstall('git+https://example.com/x.git').url, 'https://example.com/x.git');
  assert.equal(planInstall('git+ssh://git@example.com/x.git').url, 'ssh://git@example.com/x.git');
});

test('inspect knows only size and hash, and runs nothing', async (t) => {
  const dir = tempDir();
  const canary = path.join(dir, 'EXECUTED');
  const source = path.join(dir, 'canary.mjs');
  // Top-level code, exactly like a real plugin's: if inspect imports this
  // file, the canary appears.
  fs.writeFileSync(source, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(canary)}, 'ran');\n` + pluginFile('canary'));

  const info = await inspectSource(source);
  assert.equal(fs.existsSync(canary), false, 'inspect executed nothing');
  assert.equal(info.kind, 'path');
  assert.equal(info.sha256.length, 64);
  assert.ok(info.size > 0);

  // The same bytes over the loopback http exception hash identically.
  const { state, url } = await serve(t, fs.readFileSync(source));
  state.body = fs.readFileSync(source);
  const viaUrl = await inspectSource(url);
  assert.equal(viaUrl.sha256, info.sha256, 'one hash for one set of bytes');
  assert.equal(fs.existsSync(canary), false, 'and still nothing ran');

  // A folder without plugin.mjs is named, not guessed at.
  const empty = tempDir();
  await assert.rejects(inspectSource(empty), /has no plugin\.mjs/);
});

test('a download over the cap is refused while it streams, not after it lands', async (t) => {
  const { state, url } = await serveStreamed(t);
  await assert.rejects(inspectSource(url), /over the 1024 KB single-file cap/);
  assert.equal(state.declared, null, 'the host declared no length, so the cap had to hold while it streamed');
  // The transfer stopped near the cap: the rest of the body was never read.
  await new Promise((r) => setTimeout(r, 250));
  assert.ok(state.sent < 32 * 256 * 1024, `the whole body was not fetched (${state.sent} bytes sent)`);
  assert.ok(state.sent <= 8 * 256 * 1024, `the download stopped near the cap (${state.sent} bytes sent)`);
});

test('a redirect cannot take a download off https', async (t) => {
  // The transport policy used to hold only for the first url: the fetch
  // followed redirects itself, so an https link could hand the download to
  // an http one over cleartext.
  const off = await serveRedirect(t, '/start.mjs', 'http://example.com/plugin.mjs');
  await assert.rejects(inspectSource(off), /http:\/\/ is refused/);

  // A redirect that stays inside the policy is still followed.
  const inside = await serveRedirect(t, '/start.mjs', '/final.mjs');
  const info = await inspectSource(inside);
  assert.equal(info.sha256.length, 64, 'the redirect was followed and the body read');
});

test('an install stages, validates, then swaps — a plugin that throws in setup leaves the old version live', async () => {
  const home = tempDir({ 'settings.json': '{}' });
  const dir = tempDir();
  const v1 = path.join(dir, 'v1.mjs');
  fs.writeFileSync(v1, pluginFile('keeper'));

  const first = await installSource(v1, { home });
  assert.equal(first.name, 'keeper');
  assert.equal(first.folder, 'keeper');
  const folder = path.join(home, 'plugins', 'keeper', 'plugin.mjs');
  assert.ok(fs.existsSync(folder), 'the plugin landed as plugins/<name>/plugin.mjs');

  const registry = readRegistry(path.join(home, 'plugins'));
  assert.equal(registry.plugins.keeper.source.type, 'path');
  // The loader reports a 16-char prefix (details().sha256); the registry keeps
  // that same form so `hashChanged` is one string compare.
  assert.equal(registry.plugins.keeper.sha256.length, 16);
  assert.equal(registry.plugins.keeper.folder, 'keeper');

  const manager = managerFor(home);
  await manager.load();
  assert.deepEqual(manager.details().loaded.map((p) => p.name), ['keeper']);
  assert.equal(await manager.runTool('KEEPER_TOOL'), 'ok');
  const goodSha = registry.plugins.keeper.sha256;

  // v2 dies in setup: the staged copy fails validation, so the swap never
  // happened and v1 is still the live plugin.
  const v2 = path.join(dir, 'v2.mjs');
  fs.writeFileSync(v2, pluginFile('keeper', `throw new Error('boom in setup');`));
  await assert.rejects(installSource(v2, { home }), /boom in setup/);

  await manager.load();
  assert.deepEqual(manager.details().loaded.map((p) => p.version), ['1.0.0'], 'v1 is still the loaded version');
  assert.equal(await manager.runTool('KEEPER_TOOL'), 'ok');
  assert.equal(readRegistry(path.join(home, 'plugins')).plugins.keeper.sha256, goodSha, 'the registry still describes v1');
  assert.deepEqual(fs.readdirSync(path.join(home, 'plugins', '.staging')), [], 'staging is swept, success or failure');
});

test('a stale hash between inspect and install refuses the swap', async (t) => {
  const home = tempDir({ 'settings.json': '{}' });
  const { state, url } = await serve(t, pluginFile('stable'));
  const info = await inspectSource(url);

  // The host changes the bytes after the person confirmed the hash.
  state.body = pluginFile('stable', 'ctx.log("changed");') + '\n// changed\n';
  await assert.rejects(installSource(url, { home, expectedSha256: info.sha256 }), /changed since it was inspected/);
  assert.equal(fs.existsSync(path.join(home, 'plugins', 'stable')), false, 'nothing was swapped in');

  // The same inspect + a matching hash installs.
  const again = await inspectSource(url);
  const result = await installSource(url, { home, expectedSha256: again.sha256 });
  assert.equal(result.name, 'stable');
});

test('a plugin that only fails in its final home is rolled back — fresh installs leave nothing, updates restore the previous version', async () => {
  const home = tempDir({ 'settings.json': '{}' });
  const manager = managerFor(home);
  const dir = tempDir();

  // Validation runs from .staging, so this plugin passes it and dies at home.
  const guard = (name, extra = '') => `
export default {
  name: '${name}',
  version: '9.9.9',
  setup(ctx) { if (!import.meta.url.includes('.staging')) throw new Error('final home refused'); ${extra} },
};
`;
  const guarded = path.join(dir, 'guarded.mjs');
  fs.writeFileSync(guarded, guard('guarded'));

  const fresh = await installSource(guarded, { home });
  await assert.rejects(finalizeInstall(fresh, manager), /final home refused/);
  assert.equal(fs.existsSync(path.join(home, 'plugins', 'guarded')), false, 'a fresh install that failed at home left no folder');
  assert.deepEqual(readRegistry(path.join(home, 'plugins')).plugins, {}, 'and no registry entry');
  assert.deepEqual(manager.details().loaded, [], 'and nothing live');

  // The update path: v1 works, v2 passes staging and dies at home — v1 comes
  // back from .trash, provenance included.
  const v1 = path.join(dir, 'keeper.mjs');
  fs.writeFileSync(v1, pluginFile('keeper'));
  const first = await installSource(v1, { home });
  await finalizeInstall(first, manager);
  assert.equal(await manager.runTool('KEEPER_TOOL'), 'ok');
  const v1Sha = readRegistry(path.join(home, 'plugins')).plugins.keeper.sha256;

  const v2 = path.join(dir, 'keeper-v2.mjs');
  fs.writeFileSync(v2, guard('keeper'));
  const attempt = await installSource(v2, { home });
  await assert.rejects(finalizeInstall(attempt, manager), /previous version was restored/);

  assert.equal(fs.existsSync(path.join(home, 'plugins', 'keeper', 'plugin.mjs')), true, 'the old folder is back');
  const back = readRegistry(path.join(home, 'plugins')).plugins.keeper;
  assert.equal(back.sha256, v1Sha, 'the registry describes the restored version again');
  await manager.load();
  assert.deepEqual(manager.details().loaded.map((p) => p.version), ['1.0.0']);
  assert.equal(await manager.runTool('KEEPER_TOOL'), 'ok');
});

test('the enabled-list rules: materialize the first disable, collapse on the way back, [NONE] for none', () => {
  assert.deepEqual(materializeEnabledList([], ['alpha', 'beta'], 'beta', false), ['alpha'], 'the first disable materializes the list');
  assert.deepEqual(materializeEnabledList(['alpha'], ['alpha', 'beta'], 'beta', true), [], 'enabling the last one collapses to the master switch');
  assert.deepEqual(materializeEnabledList(['alpha', 'beta'], ['alpha', 'beta'], 'beta', false), ['alpha']);
  assert.deepEqual(materializeEnabledList(['alpha'], ['alpha', 'beta'], 'alpha', false), [NONE_NAME], 'disabling the last one cannot read as "everything"');
  assert.deepEqual(materializeEnabledList([], ['alpha'], 'alpha', true), [], 'enabling under the master switch is a no-op');

  assert.deepEqual(stripFromEnabled([], 'alpha'), [], 'a master-on list has nothing to strip');
  assert.deepEqual(stripFromEnabled(['alpha', 'beta'], 'alpha'), ['beta']);
  assert.deepEqual(stripFromEnabled(['alpha'], 'alpha'), [NONE_NAME], 'removing the last pinned name is not "everything on"');

  // The collapse decision counts known names, registry included: enabling
  // gamma must not switch a silently-disabled beta back on.
  assert.deepEqual(materializeEnabledList(['alpha'], ['alpha', 'beta'], 'gamma', true), ['alpha', 'gamma']);
  assert.deepEqual(knownNames({ loaded: [{ name: 'alpha' }] }, { plugins: { beta: { folder: 'beta' } } }).sort(), ['alpha', 'beta']);
  assert.deepEqual(knownNames({ loaded: [] }, null), []);
  assert.deepEqual(knownNames({ loaded: [{ name: NONE_NAME }] }, null), [], 'the sentinel is not a plugin');
});

test('remove refuses an unmanaged file, and a managed folder moves to trash instead of dying', async () => {
  const home = tempDir({ 'settings.json': '{}' });
  const plugins = path.join(home, 'plugins');
  fs.mkdirSync(plugins, { recursive: true });
  fs.writeFileSync(path.join(plugins, 'notes.mjs'), pluginFile('notes'));

  assert.throws(() => removePlugin('notes', { home }), /not installed by aipass/);
  assert.ok(fs.existsSync(path.join(plugins, 'notes.mjs')), 'the refusal left it alone');

  const forced = removePlugin('notes', { home, force: true });
  assert.equal(forced.removed, true);
  assert.equal(fs.existsSync(path.join(plugins, 'notes.mjs')), false);
  assert.ok(forced.trashed.includes('.trash'), 'the file is in trash, not gone');

  const dir = tempDir();
  const source = path.join(dir, 'keeper.mjs');
  fs.writeFileSync(source, pluginFile('keeper'));
  await installSource(source, { home });

  const out = removePlugin('keeper', { home });
  assert.equal(fs.existsSync(path.join(plugins, 'keeper')), false);
  assert.ok(fs.existsSync(out.trashed), 'the folder is in trash');
  assert.deepEqual(readRegistry(plugins).plugins, {}, 'and the registry forgot it cleanly');
});

test('deleting the registry never blocks loading — provenance is not a gate', async () => {
  const home = tempDir({ 'settings.json': '{}' });
  const dir = tempDir();
  const source = path.join(dir, 'keeper.mjs');
  fs.writeFileSync(source, pluginFile('keeper'));
  await installSource(source, { home });

  const plugins = path.join(home, 'plugins');
  fs.rmSync(path.join(plugins, '.registry.json'));
  const manager = managerFor(home);
  const details = await manager.load();
  assert.deepEqual(details.loaded.map((p) => p.name), ['keeper'], 'a missing registry changes nothing about loading');

  const decorated = decorateDetails(details, readRegistry(plugins));
  assert.equal(decorated.loaded[0].installed, null, 'it reads as unmanaged, which is honest');
  assert.equal(decorated.loaded[0].hashChanged, false);

  // A corrupt file reads the same way instead of throwing.
  fs.writeFileSync(path.join(plugins, '.registry.json'), 'not json');
  assert.deepEqual(readRegistry(plugins).plugins, {});
});

test('an install refuses names that would leave the plugins directory or break Windows', () => {
  const home = tempDir({ 'settings.json': '{}' });
  const source = path.join(tempDir(), 'x.mjs');
  fs.writeFileSync(source, pluginFile('x'));
  return (async () => {
    await assert.rejects(installSource(source, { home, name: '../escape' }), /not a usable name/);
    await assert.rejects(installSource(source, { home, name: 'con' }), /reserved device name/);
    await assert.rejects(installSource(source, { home, name: 'trailing.' }), /ends with a dot/);
    assert.equal(fs.existsSync(path.join(home, '..', 'escape')), false);
  })();
});

test('a plugin cannot name itself __proto__ — the registry is not a place to keep a prototype', async () => {
  const home = tempDir({ 'settings.json': '{}' });
  const dir = tempDir();
  for (const name of ['__proto__', 'constructor', 'prototype']) {
    const source = path.join(dir, `${name}.mjs`);
    fs.writeFileSync(source, namedPlugin(name));
    // The declared name is the registry's key: `plugins['__proto__'] = …`
    // sets the prototype instead of adding a record, and the plugin would
    // be live with no provenance row at all.
    await assert.rejects(installSource(source, { home }), /unusable name/);
    assert.equal(fs.existsSync(path.join(home, 'plugins', name)), false, `${name} was not installed`);
  }
  const plugins = readRegistry(path.join(home, 'plugins')).plugins;
  assert.deepEqual(Object.keys(plugins), [], 'the registry holds no record');
  assert.equal(Object.getPrototypeOf(plugins), Object.prototype, 'and its prototype is still its own');
});

test('update re-fetches the recorded source, and refuses a name it never installed', async () => {
  const home = tempDir({ 'settings.json': '{}' });
  const dir = tempDir();
  const source = path.join(dir, 'keeper.mjs');
  fs.writeFileSync(source, pluginFile('keeper'));
  await installSource(source, { home });

  const record = updateSourceFor(readRegistry(path.join(home, 'plugins')), 'keeper');
  assert.equal(record.name, 'keeper');
  assert.equal(record.source.ref, source, 'the recorded ref is what update re-reads');
  assert.equal(record.sha256.length, 16, 'the recorded hash rides along');

  assert.throws(() => updateSourceFor(readRegistry(path.join(home, 'plugins')), 'handmade'),
    /no recorded source for handmade/);
});

test('the trash keeps one previous copy per name — a third install prunes the first', async () => {
  const home = tempDir({ 'settings.json': '{}' });
  const dir = tempDir();
  const manager = managerFor(home);
  const trash = path.join(home, 'plugins', '.trash');
  const copies = () => (fs.existsSync(trash) ? fs.readdirSync(trash).filter((n) => n.startsWith('keeper-')) : []);
  const write = (tag) => {
    const file = path.join(dir, `keeper-${tag}.mjs`);
    fs.writeFileSync(file, `${pluginFile('keeper')}// ${tag}\n`);
    return file;
  };
  const trashedBody = () => fs.readFileSync(path.join(trash, copies()[0], 'plugin.mjs'), 'utf8');

  await finalizeInstall(await installSource(write('one'), { home }), manager);
  assert.deepEqual(copies(), [], 'a first install has nothing to keep');

  await finalizeInstall(await installSource(write('two'), { home }), manager);
  assert.match(trashedBody(), /\/\/ one\n/, 'the replaced version is kept');

  await finalizeInstall(await installSource(write('three'), { home }), manager);
  assert.equal(copies().length, 1, 'still one copy per name');
  assert.match(trashedBody(), /\/\/ two\n/, 'the newest previous version is the one kept');
});

/* --------------------------------------------------------- fetched trees */

test('a tree over the cap is refused while it is copied, and the partial copy is gone', async () => {
  // The cap used to be checked after the whole tree was on the disk, which
  // is the wrong order: the refusal came after the disk was full.
  const src = tempDir({ 'a.txt': 'x'.repeat(60 * 1024), 'b.txt': 'y'.repeat(60 * 1024) });
  const dest = path.join(tempDir(), 'copy');
  await assert.rejects(copyTreeBounded(src, dest, { maxBytes: 100 * 1024 }), /over the 100 KB cap for a fetched source/);
  assert.equal(fs.existsSync(dest), false, 'the half-copied tree was taken with it');
});

test('a tree inside the cap is copied, file for file', async () => {
  const src = tempDir({ 'plugin.mjs': 'export default {};', 'lib/a.txt': 'hello' });
  const dest = path.join(tempDir(), 'copy');
  await copyTreeBounded(src, dest, { maxBytes: 1024 * 1024 });
  assert.equal(fs.readFileSync(path.join(dest, 'plugin.mjs'), 'utf8'), 'export default {};');
  assert.equal(fs.readFileSync(path.join(dest, 'lib', 'a.txt'), 'utf8'), 'hello');
});

test('a link that points out of the fetched tree is refused, not followed', async () => {
  // `dereference: true` resolved every link, so a link to C:\\ copied the
  // whole drive into the plugins folder.
  const outside = tempDir({ 'secret.txt': 'not yours' });
  const src = tempDir({ 'plugin.mjs': 'export default {};' });
  fs.symlinkSync(outside, path.join(src, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  const dest = path.join(tempDir(), 'copy');
  await assert.rejects(copyTreeBounded(src, dest, {}), /points outside the fetched source/);
  assert.equal(fs.existsSync(dest), false, 'and nothing was left behind');
});

/* ------------------------------------------------------------------- git */

const hasGit = () => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
};

const git = (cwd, args) => execFileSync('git', args, { cwd, stdio: 'pipe', windowsHide: true });

const hasNpm = () => {
  try {
    // npm is a .cmd shim on Windows; the shell is fine in a test.
    execSync('npm --version', { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
};

/** A repository with one commit holding a plugin. */
function gitRepoWithPlugin(body) {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'plugin.mjs'), body);
  git(dir, ['init', '--quiet']);
  git(dir, ['add', '.']);
  git(dir, ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '--quiet', '-m', 'plugin']);
  return dir;
}

test('a git source is cloned, validated and swapped — the registry remembers where it came from', async (t) => {
  if (!hasGit()) return t.skip('git is not on this machine');
  const home = tempDir({ 'settings.json': '{}' });
  const repo = gitRepoWithPlugin(pluginFile('cloned'));
  const spec = `git+${pathToFileURL(repo).href}`;

  const info = await inspectSource(spec);
  assert.equal(info.kind, 'git');
  assert.equal(info.entry, 'plugin.mjs');
  assert.equal(info.sha256.length, 64, 'the hash of what would run is known before it runs');

  const result = await installSource(spec, { home, expectedSha256: info.sha256 });
  assert.equal(result.name, 'cloned');
  assert.ok(fs.existsSync(path.join(home, 'plugins', 'cloned', 'plugin.mjs')), 'it landed as a plugin folder');

  const registry = readRegistry(path.join(home, 'plugins'));
  assert.equal(registry.plugins.cloned.source.type, 'git');
  assert.equal(registry.plugins.cloned.source.ref, spec, 'the recorded source is what update re-reads');
});

test('a git source that moved since it was inspected refuses the swap', async (t) => {
  if (!hasGit()) return t.skip('git is not on this machine');
  const home = tempDir({ 'settings.json': '{}' });
  const repo = gitRepoWithPlugin(pluginFile('moving'));
  const spec = `git+${pathToFileURL(repo).href}`;

  const info = await inspectSource(spec);
  // The branch moves: the repository changes after the person saw the hash.
  fs.writeFileSync(path.join(repo, 'plugin.mjs'), pluginFile('moving', 'ctx.log("changed");'));
  git(repo, ['add', '.']);
  git(repo, ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '--quiet', '-m', 'moved']);

  await assert.rejects(installSource(spec, { home, expectedSha256: info.sha256 }), /changed since it was inspected/);
  assert.equal(fs.existsSync(path.join(home, 'plugins', 'moving')), false, 'nothing was swapped in');
});

test('an npm source is installed by npm — with its scripts switched off', async (t) => {
  if (!hasNpm()) return t.skip('npm is not on this machine');
  const home = tempDir({ 'settings.json': '{}' });
  // A local package: npm installs it like any other dependency, and the
  // scripts in it are the thing that must not run.
  const pkg = tempDir();
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: 'local-plugin', version: '2.0.0' }));
  fs.writeFileSync(path.join(pkg, 'plugin.mjs'), pluginFile('localplugin'));
  fs.writeFileSync(path.join(pkg, 'postinstall.js'), 'throw new Error("the install script ran");\n');
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({
    name: 'local-plugin', version: '2.0.0', scripts: { postinstall: 'node postinstall.js' },
  }));

  const spec = `npm:${pkg}`;
  const info = await inspectSource(spec);
  assert.equal(info.kind, 'npm');
  assert.equal(info.entry, 'plugin.mjs');
  assert.equal(info.sha256.length, 64);

  const result = await installSource(spec, { home, expectedSha256: info.sha256 });
  assert.equal(result.name, 'localplugin', 'the plugin declares its own name');
  assert.ok(fs.existsSync(path.join(home, 'plugins', 'localplugin', 'plugin.mjs')), 'it landed as a plugin folder');
  assert.equal(readRegistry(path.join(home, 'plugins')).plugins.localplugin.source.type, 'npm');
});
