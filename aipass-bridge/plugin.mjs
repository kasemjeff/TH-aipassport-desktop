#!/usr/bin/env node
// aipass plugin — install, inspect, enable, disable and remove plugins.
//
//   aipass plugin                             list what is installed and live
//   aipass plugin inspect <path|url>          size + sha256 of what would run
//   aipass plugin install <path|url> [--name <id>] [--force] [--yes]
//   aipass plugin remove <name> [--force]
//   aipass plugin enable|disable <name>
//
// Install is the consent moment: the hash of the bytes is printed and
// confirmed before any plugin code runs — validation imports the staged copy,
// and nothing before that does. If the desktop backend is listening, this
// process asks it to perform the swap, so an open window updates live;
// with no backend it does the same work against the same files, and the next
// `aipass desktop` start reads them.
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { aipassHome, Settings } from './harness/settings.mjs';
import { PluginManager } from './harness/plugins.mjs';
import {
  inspectSource, installSource, finalizeInstall, removePlugin, readRegistry,
  decorateDetails, materializeEnabledList, stripFromEnabled, knownNames, NONE_NAME, pluginsDirFor,
} from './harness/install.mjs';
import { tryDesktopRpc } from './harness/desktop-rpc.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'list';

// Flags with a value take it; the rest are boolean. Everything else is
// positional. `--name <id>` is the only value flag this CLI has.
const flags = new Set();
const positional = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--name') { flags.add('--name'); positional.name = argv[++i] ?? null; continue; }
  if (a.startsWith('--')) { flags.add(a); continue; }
  positional.push(a);
}

const home = aipassHome();
const pluginsDir = pluginsDirFor(home);
const settings = new Settings();
const force = flags.has('--force');

const registryOf = () => readRegistry(pluginsDir);
const decorated = (details) => decorateDetails(details, registryOf());

/** A manager over the real directory and the real filter, loaded once. */
async function liveManager() {
  const manager = new PluginManager({ dir: pluginsDir, settings, log: () => {} });
  await manager.load();
  return manager;
}

const usage = () => {
  console.log('usage: aipass plugin [list|inspect <src>|install <src> [--name id] [--force] [--yes]|remove <name> [--force]|enable <name>|disable <name>]');
  process.exit(1);
};

const say = (line) => console.log(line);

try {
  if (cmd === 'list' || cmd === 'ls') {
    // A running backend holds the live truth (its manager already loaded);
    // with none, this process loads the same way the backend will.
    const viaBackend = await tryDesktopRpc('plugins.list');
    const details = decorated(viaBackend?.ok ? viaBackend.result : (await liveManager()).details());
    const known = knownNames(details, registryOf());

    if (!known.length && !details.failed.length) {
      say(`(no plugins yet — aipass plugin install <path|url>)`);
      say(`  directory: ${details.dir}`);
      process.exit(0);
    }
    say(`${known.length} plugin(s) in ${details.dir}:`);
    for (const p of details.loaded) {
      say(`  ${p.name} ${p.version}  ${p.description ?? ''}`.trimEnd());
      if (p.installed) {
        say(`      installed from ${p.installed.source.ref} (${p.sha256})${p.hashChanged ? ' — the file changed since install' : ''}`);
      } else {
        say(`      placed by hand (not installed by aipass)`);
      }
    }
    const loadedNames = new Set(details.loaded.map((p) => p.name));
    for (const name of known) {
      if (!loadedNames.has(name)) say(`  ${name}  (installed, disabled)`);
    }
    for (const f of details.failed) say(`  ${path.basename(f.file)}  failed: ${f.error}`);
    process.exit(0);
  }

  if (cmd === 'inspect') {
    const source = positional[0];
    if (!source) usage();
    const info = await inspectSource(source, { base: process.cwd() });
    say(`source: ${info.ref}`);
    say(`entry:  ${info.entry}`);
    say(`size:   ${info.size} bytes`);
    say(`sha256: ${info.sha256}`);
    say('nothing was executed to answer this — installing is what runs it');
    process.exit(0);
  }

  if (cmd === 'install') {
    const source = positional[0];
    if (!source) usage();

    // 1. Report first: the hash is what the person is consenting to.
    const info = await inspectSource(source, { base: process.cwd() });
    say(`install into ${pluginsDir}`);
    say(`  source: ${info.ref}`);
    say(`  entry:  ${info.entry} (${info.size} bytes)`);
    say(`  sha256: ${info.sha256}`);
    say('  installing loads this code in the backend process — plugins are not sandboxed.');

    if (!flags.has('--yes')) {
      if (!process.stdin.isTTY) {
        console.error('err: refusing to install without confirmation — pass --yes to confirm non-interactively');
        process.exit(1);
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question('install this plugin? [y/N] ');
      rl.close();
      if (!/^y(es)?$/i.test(answer.trim())) { say('not installed'); process.exit(0); }
    }

    // 2. The backend does it when one is listening — the open window updates
    //    live. Its refusal is final; falling back would do the same work
    //    behind the answer the person just received.
    const viaBackend = await tryDesktopRpc('plugins.install', {
      source: info.ref, name: positional.name, expectedSha256: info.sha256, force, installedBy: 'cli',
    });
    if (viaBackend && !viaBackend.ok) { console.error(`err: ${viaBackend.error}`); process.exit(1); }
    if (viaBackend?.ok) {
      const p = viaBackend.result.plugin;
      say(`installed ${p.name} ${p.version} — the open window already has it`);
      process.exit(0);
    }

    const result = await installSource(info.ref, {
      pluginsDir, name: positional.name, expectedSha256: info.sha256, force, installedBy: 'cli',
      log: (line) => say(`  ${line}`),
    });
    // An explicit enabled-list names what runs; the newcomer joins it, the
    // same decision the window makes when it installs into a pinned list.
    const list = settings.get('plugins');
    if (Array.isArray(list) && list.length && !list.includes(result.name)) {
      settings.set({ plugins: [...list.filter((n) => n !== NONE_NAME), result.name] });
    }
    const manager = new PluginManager({ dir: pluginsDir, settings, log: () => {} });
    const details = await finalizeInstall(result, manager);
    const p = decorateDetails(details, registryOf()).loaded.find((x) => x.name === result.name);
    say(`installed ${p?.name} ${p?.version ?? ''} — the desktop app will load it at its next start`);
    process.exit(0);
  }

  if (cmd === 'remove' || cmd === 'rm') {
    const name = positional[0];
    if (!name) usage();
    const viaBackend = await tryDesktopRpc('plugins.remove', { name, force });
    if (viaBackend && !viaBackend.ok) { console.error(`err: ${viaBackend.error}`); process.exit(1); }
    if (viaBackend?.ok) {
      say(`removed ${viaBackend.result.name} — the previous copy is in ${viaBackend.result.trashed}`);
      process.exit(0);
    }
    const out = removePlugin(name, { pluginsDir, force });
    const list = settings.get('plugins');
    if (Array.isArray(list) && list.includes(name)) settings.set({ plugins: stripFromEnabled(list, name) });
    say(`removed ${out.name} — the previous copy is in ${out.trashed}`);
    process.exit(0);
  }

  if (cmd === 'enable' || cmd === 'disable') {
    const name = positional[0];
    if (!name) usage();
    const enabled = cmd === 'enable';

    const viaBackend = await tryDesktopRpc(`plugins.${cmd}`, { name });
    if (viaBackend && !viaBackend.ok) { console.error(`err: ${viaBackend.error}`); process.exit(1); }
    if (viaBackend?.ok) {
      const live = viaBackend.result.details.loaded.some((p) => p.name === name);
      say(live ? `${name} is enabled` : `${name} is disabled`);
      process.exit(0);
    }

    const manager = await liveManager();
    const details = manager.details();
    const names = knownNames(details, registryOf());
    const list = settings.get('plugins');
    if (!names.includes(name) && !(Array.isArray(list) && list.includes(name))) {
      console.error(`err: no plugin named ${name} — run 'aipass plugin list'`);
      process.exit(1);
    }
    const next = materializeEnabledList(list, names, name, enabled);
    settings.set({ plugins: next });
    await manager.load();
    const live = manager.details().loaded.some((p) => p.name === name);
    if (next.length === 1 && next[0] === NONE_NAME) say('all plugins are now disabled');
    else if (live) say(`${name} is enabled`);
    else say(`${name} is disabled`);
    if (next.length) say(`  enabled list: ${next.join(', ')}`);
    process.exit(0);
  }

  usage();
} catch (err) {
  console.error(`err: ${err.message ?? err}`);
  process.exit(1);
}
