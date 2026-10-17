// The plugin filter, pinned.
//
// `settings.plugins` is a list of names to load; an empty list means
// "everything found". A plugin that is not wanted must not load at all: the
// manager used to run its setup() first and filter the listing afterwards,
// which left a "disabled" plugin's tools, RPC methods and panels live while
// the window said it was off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { tempDir } from './harness.mjs';
import { PluginManager } from '../harness/plugins.mjs';
import { Settings } from '../harness/settings.mjs';

const pluginFile = (name, marker) => `
export default {
  name: '${name}',
  version: '1.0.0',
  description: 'test plugin',
  setup(ctx) {
    ctx.tools.register('${marker}', () => 'ok');
    ctx.rpc.method('${name}.ping', () => 'pong');
    ctx.panel({ id: '${name}', title: '${name} panel', render: () => '' });
  },
};
`;

const home = (settings) => tempDir({
  'settings.json': settings,
  'plugins/alpha.mjs': pluginFile('alpha', 'ALPHA_TOOL'),
  'plugins/beta.mjs': pluginFile('beta', 'BETA_TOOL'),
});

test('only the plugins named in settings are loaded — a disabled one registers nothing', async () => {
  const dir = home(JSON.stringify({ plugins: ['alpha'] }));
  const settings = new Settings(dir);
  const manager = new PluginManager({ dir: path.join(dir, 'plugins'), settings, log: () => {} });

  const details = await manager.load();

  assert.deepEqual(details.loaded.map((p) => p.name), ['alpha']);
  assert.deepEqual(details.failed, []);
  assert.deepEqual(details.tools, ['ALPHA_TOOL'], 'the disabled plugin registered no tool');
  assert.equal(manager.hasMethod('beta.ping'), false, 'and no rpc method either');
  assert.deepEqual(details.panels.map((p) => p.id), ['alpha'], 'and no panel');
});

test('a plugin that throws mid-setup leaves nothing behind — failed means nothing is live', async () => {
  // The disabled-plugin rule ("nothing of it is loaded") applies to a plugin
  // that dies halfway through setup just the same: the window lists it as
  // failed, so its tools, methods, panels and settings must not answer.
  const dir = tempDir({
    'settings.json': JSON.stringify({ plugins: [] }),
    'plugins/aa-half.mjs': `
export default {
  name: 'aa-half',
  version: '1.0.0',
  setup(ctx) {
    ctx.tools.register('HALF_TOOL', () => 'should not run');
    ctx.rpc.method('half.ping', () => 'pong');
    ctx.panel({ id: 'half', title: 'half panel', render: () => '' });
    ctx.settings.define({ key: 'half.setting' });
    throw new Error('boom mid-setup');
  },
};
`,
    'plugins/zz-good.mjs': pluginFile('zz-good', 'GOOD_TOOL'),
  });
  const manager = new PluginManager({ dir: path.join(dir, 'plugins'), settings: new Settings(dir), log: () => {} });

  const details = await manager.load();

  assert.deepEqual(details.failed.map((f) => path.basename(f.file)), ['aa-half.mjs']);
  assert.deepEqual(details.loaded.map((p) => p.name), ['zz-good']);
  assert.deepEqual(details.tools, ['GOOD_TOOL'], 'the failed plugin registered no tool');
  assert.equal(manager.hasMethod('half.ping'), false, 'and no rpc method');
  assert.deepEqual(details.panels.map((p) => p.id), ['zz-good'], 'and no panel');
  assert.deepEqual(details.settings, [], 'and no setting definition');
  assert.match(await manager.runTool('HALF_TOOL'), /no such plugin tool/);
});

test('an empty list means everything found, and a reload honours a changed filter', async () => {
  const dir = home(JSON.stringify({ plugins: [] }));
  const settings = new Settings(dir);
  const manager = new PluginManager({ dir: path.join(dir, 'plugins'), settings, log: () => {} });

  await manager.load();
  assert.deepEqual(manager.toolTable().map((t) => t.marker).sort(), ['ALPHA_TOOL', 'BETA_TOOL']);

  // What the settings window does: save the new list, then reload plugins.
  settings.set({ plugins: ['alpha'] });
  await manager.reload();

  assert.deepEqual(manager.toolTable().map((t) => t.marker), ['ALPHA_TOOL'], 'beta is gone after the reload');
  assert.equal(manager.hasMethod('beta.ping'), false);
  assert.deepEqual(manager.details().loaded.map((p) => p.name), ['alpha']);
});
