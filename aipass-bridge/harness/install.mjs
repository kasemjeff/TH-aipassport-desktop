// install.mjs — where plugins come from, and the only code that puts one
// there. The design is in `docs/PLUGINS_MCP_DESIGN.md`; this is it, in order:
//
//   plan(source)    pure: a string → what it is, or a named refusal
//   inspect(source) bytes, size, sha256 — reports, never executes
//   install(source) stage → validate → swap → registry; a failure leaves the
//                   previous version exactly where it was
//   finalize(result, manager) reload the live manager and roll the swap back
//                   if the plugin only fails in its final home
//
// Three rules the code keeps:
//   - Plan and inspect run no plugin code. Validation does (an ESM import runs
//     top-level code), so it happens only after the caller asked the person.
//   - Nothing is ever deleted: a replaced version moves to `.trash`, and a
//     hand-dropped plugin is only replaced with an explicit force.
//   - The registry (`.registry.json`) records provenance and can be deleted at
//     any time without breaking loading — it answers "where did this come
//     from", it does not gate anything.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { aipassHome } from './settings.mjs';
import { PluginManager } from './plugins.mjs';

/** A single-file pull is source, not media; 1 MB is generous for one module. */
export const MAX_URL_BYTES = 1024 * 1024;

/**
 * Folder names Windows reserves. `plugins/con/` does not fail politely on
 * NTFS — it fails as "the path is not a valid name" three steps later, which
 * reads as a bug in the installer. Refuse it here, where the name is checked.
 */
const WINDOWS_RESERVED = new Set(['con', 'prn', 'aux', 'nul',
  ...Array.from({ length: 9 }, (_, i) => `com${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `lpt${i + 1}`)]);

/**
 * The enabled-list cannot say "none" with `[]` — empty has meant "everything
 * found" since the first release, and a hand-edited settings file must keep
 * meaning that. Disabling the last plugin therefore writes this name, which no
 * real plugin can have (names must start alphanumeric), so it matches nothing.
 */
export const NONE_NAME = '(none)';

/**
 * Is `name` usable as a folder under the plugins directory?
 * The charset keeps path separators, `..` and drive colons out by construction;
 * the trailing-dot and reserved-name rules are Windows' filesystem talking.
 */
export function nameProblem(name) {
  const s = String(name ?? '').trim();
  if (!s) return 'the name is empty';
  if (s.length > 64) return 'the name is longer than 64 characters';
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(s)) return `"${s}" is not a usable name — letters, digits, dot, dash, underscore only`;
  if (s.endsWith('.')) return `"${s}" ends with a dot, which Windows strips`;
  if (WINDOWS_RESERVED.has(s.toLowerCase())) return `"${s}" is a reserved device name on Windows`;
  return null;
}

/** The plugins directory a home owns. One definition, four callers. */
export const pluginsDirFor = (home = aipassHome()) => path.join(home, 'plugins');

const stagingDirFor = (pluginsDir) => path.join(pluginsDir, '.staging');
const trashDirFor = (pluginsDir) => path.join(pluginsDir, '.trash');

const isLoopbackHost = (hostname) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(hostname).toLowerCase());

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

/**
 * What a source string is, before anything touches the disk.
 *
 * `path` may be relative (resolved against `base`), absolute, or start with
 * `~`. `url` must be https, with one deliberate exception: plain http for a
 * loopback host, so a test (or a server on this machine) can serve a fixture —
 * the exception is named in the refusal it does not get, not in a comment
 * somewhere else.
 */
export function planInstall(source, { base = process.cwd() } = {}) {
  const raw = String(source ?? '').trim();
  if (!raw) throw new Error('no source given — a path, a folder, or an https:// URL');

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /^(npm|git\+)/i.test(raw)) {
    if (/^npm:/i.test(raw) || /^git\+/i.test(raw)) {
      // Phase 2 by design: a fetched package needs dependencies installed and
      // an entry contract, and a spine that works first is what those land on.
      throw new Error(`${raw.split(':')[0]}: sources are not installed yet — download the plugin and install it from a local path or an https:// URL`);
    }
    let url;
    try { url = new URL(raw); } catch { throw new Error(`not a URL: ${raw}`); }
    if (url.protocol === 'http:') {
      if (!isLoopbackHost(url.hostname)) throw new Error('http:// is refused (a plain link can be rewritten in transit) — use https://, or http on 127.0.0.1/localhost for a local test host');
    } else if (url.protocol !== 'https:') {
      throw new Error(`unsupported scheme ${url.protocol}// — use https:// or a local path`);
    }
    return { kind: 'url', ref: url.href };
  }

  const expanded = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
  return { kind: 'path', ref: path.resolve(base, expanded) };
}

async function fetchBytes(ref, fetchImpl) {
  const res = await fetchImpl(ref, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const declared = Number(res.headers?.get?.('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_URL_BYTES) {
    throw new Error(`the file is ${Math.round(declared / 1024)} KB — over the ${MAX_URL_BYTES / 1024} KB single-file cap`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_URL_BYTES) {
    throw new Error(`the file is ${Math.round(bytes.length / 1024)} KB — over the ${MAX_URL_BYTES / 1024} KB single-file cap`);
  }
  return bytes;
}

/** Every file under `dir`, for the folder-size figure inspect reports. */
async function walkFiles(dir, out = []) {
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/**
 * What the source holds — size and content hash, and **no execution**. This is
 * what a person confirms against: the hash of the bytes that will run, known
 * before they run. A folder's hash is its entry file's (plugin.mjs), because
 * that is the file the loader records and the registry compares.
 */
export async function inspectSource(source, { base = process.cwd(), fetchImpl = fetch } = {}) {
  const plan = planInstall(source, { base });
  if (plan.kind === 'url') {
    const bytes = await fetchBytes(plan.ref, fetchImpl);
    return { kind: 'url', ref: plan.ref, size: bytes.length, sha256: sha256(bytes), entry: 'plugin.mjs' };
  }
  const st = fs.statSync(plan.ref);
  if (st.isFile()) {
    if (!plan.ref.endsWith('.mjs')) throw new Error(`not a plugin file: ${plan.ref} — a single-file plugin is an .mjs module`);
    const bytes = fs.readFileSync(plan.ref);
    return { kind: 'path', ref: plan.ref, size: bytes.length, sha256: sha256(bytes), entry: path.basename(plan.ref) };
  }
  if (st.isDirectory()) {
    const entry = path.join(plan.ref, 'plugin.mjs');
    if (!fs.existsSync(entry)) throw new Error(`${plan.ref} has no plugin.mjs — a plugin folder needs one`);
    const entryBytes = fs.readFileSync(entry);
    const files = await walkFiles(plan.ref);
    const size = files.reduce((n, f) => { try { return n + fs.statSync(f).size; } catch { return n; } }, 0);
    return {
      kind: 'path', ref: plan.ref,
      size, sha256: sha256(entryBytes), entry: 'plugin.mjs',
      hasPackageJson: fs.existsSync(path.join(plan.ref, 'package.json')), files: files.length,
    };
  }
  throw new Error(`nothing to install at ${plan.ref}`);
}

/** The registry as an object, whatever the file happens to contain. */
export function readRegistry(pluginsDir) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(pluginsDir, '.registry.json'), 'utf8'));
    if (data && typeof data === 'object' && data.plugins && typeof data.plugins === 'object') {
      return { version: 1, plugins: { ...data.plugins } };
    }
  } catch { /* missing or malformed reads as empty — provenance is advisory */ }
  return { version: 1, plugins: {} };
}

/** Atomic, like settings.json: a crash mid-write never leaves half a registry. */
export function writeRegistry(pluginsDir, data) {
  fs.mkdirSync(pluginsDir, { recursive: true });
  const file = path.join(pluginsDir, '.registry.json');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...data }, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** A plugin's loaded detail + what the registry remembers about it. */
export function decorateDetails(details, registry) {
  const known = registry?.plugins ?? {};
  return {
    ...details,
    loaded: details.loaded.map((p) => {
      const rec = known[p.name] ?? null;
      return { ...p, installed: rec, hashChanged: Boolean(rec?.sha256 && rec.sha256 !== p.sha256) };
    }),
  };
}

/**
 * The enabled-list rules, in one pure function both doors call.
 *
 * `[]` is the master switch (everything, now and later). The first disable
 * materializes the list; enabling back collapses it once it covers every
 * known name (loaded plus registry — see `knownNames`) — an explicit list that
 * equals everything would silently turn *off* the next install. Disabling the
 * last name leaves [NONE_NAME], because `[]` would read as "everything" and
 * turn the plugin back on.
 */
export function materializeEnabledList(currentList, knownNamesList, name, enabled) {
  const list = Array.isArray(currentList) ? [...currentList] : [];
  const all = [...new Set(knownNamesList.filter(Boolean))];
  if (enabled) {
    if (!list.length) return []; // master on already covers it
    const next = [...new Set([...list.filter((n) => n !== NONE_NAME), name])];
    return all.every((n) => next.includes(n)) ? [] : next;
  }
  const base = (list.length ? list : all).filter((n) => n !== NONE_NAME);
  const next = base.filter((n) => n !== name);
  return next.length ? next : [NONE_NAME];
}

/** Removing a plugin also unpins it from an explicit enabled-list. */
export function stripFromEnabled(currentList, name) {
  const list = Array.isArray(currentList) ? currentList : [];
  if (!list.length) return list; // master on — nothing to strip
  const next = list.filter((n) => n !== name);
  return next.length ? next : [NONE_NAME];
}

/**
 * Every plugin name a collapse decision may consider: what is loaded now plus
 * what the registry remembers. The registry half matters — `plugins: ['alpha']`
 * implicitly switches off an installed, currently-disabled `beta`, and a
 * collapse that only counted loaded names would quietly switch `beta` back on
 * the moment `gamma` is enabled.
 */
export function knownNames(details, registry) {
  const names = new Set(details?.loaded?.map((p) => p.name) ?? []);
  for (const key of Object.keys(registry?.plugins ?? {})) names.add(key);
  names.delete(NONE_NAME);
  return [...names];
}

/** Move a path out of the way, keeping it — deletions are the user's to make. */
function toTrash(pluginsDir, target) {
  const trash = trashDirFor(pluginsDir);
  fs.mkdirSync(trash, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(trash, `${path.basename(target)}-${stamp}`);
  fs.renameSync(target, dest);
  return dest;
}

/**
 * Install one source. Returns the loaded plugin's detail plus the swap
 * bookkeeping `finalize` needs; on any refusal it throws with the reason and
 * leaves the tree as it found it (staging removed, previous version untouched).
 */
export async function installSource(source, {
  home = aipassHome(),
  pluginsDir = pluginsDirFor(home),
  name = null,
  expectedSha256 = null,
  force = false,
  base = process.cwd(),
  fetchImpl = fetch,
  installedBy = 'cli',
  log = () => {},
} = {}) {
  const plan = planInstall(source, { base });

  // 1. Get the bytes into a staging tree that mirrors the final layout
  //    (one folder with plugin.mjs inside), so validation loads the same
  //    shape production will.
  fs.mkdirSync(stagingDirFor(pluginsDir), { recursive: true });
  const stageRoot = path.join(stagingDirFor(pluginsDir), `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`);
  const stageData = path.join(stageRoot, 'data');
  fs.mkdirSync(stageData, { recursive: true });
  const discardStaging = () => { try { fs.rmSync(stageRoot, { recursive: true, force: true }); } catch { /* best effort */ } };

  try {
    if (plan.kind === 'url') {
      const bytes = await fetchBytes(plan.ref, fetchImpl);
      const got = sha256(bytes);
      if (expectedSha256 && got !== expectedSha256) {
        throw new Error(`the file changed since it was inspected (expected ${expectedSha256.slice(0, 12)}…, got ${got.slice(0, 12)}…) — inspect it again`);
      }
      fs.writeFileSync(path.join(stageData, 'plugin.mjs'), bytes);
    } else {
      const st = fs.statSync(plan.ref);
      if (st.isDirectory()) {
        await fs.promises.cp(plan.ref, stageData, { recursive: true });
      } else {
        if (!plan.ref.endsWith('.mjs')) throw new Error(`not a plugin file: ${plan.ref} — a single-file plugin is an .mjs module`);
        fs.copyFileSync(plan.ref, path.join(stageData, 'plugin.mjs'));
      }
      const entry = path.join(stageData, 'plugin.mjs');
      if (!fs.existsSync(entry)) throw new Error(`${plan.ref} has no plugin.mjs — a plugin folder needs one`);
      if (expectedSha256 && sha256(fs.readFileSync(entry)) !== expectedSha256) {
        throw new Error('the file changed since it was inspected — inspect it again');
      }
    }

    // 2. Validate by loading the staged copy with the real loader. This is
    //    the step that executes top-level code; it runs here, after consent,
    //    in a directory the loader would accept in production.
    const probe = new PluginManager({ dir: stageRoot, settings: null, events: null, log: () => {} });
    const details = await probe.load();
    if (!details.loaded.length) {
      throw new Error(details.failed[0]?.error ?? 'not a plugin: the file needs a default export with setup(ctx)');
    }
    const found = details.loaded[0];

    // 3. Where it lands. The declared name is the folder, because the enabled
    //    list, the window and the registry all speak that name.
    const folder = (name ?? found.name)?.trim();
    const problem = nameProblem(folder);
    if (problem) throw new Error(`the plugin declares an unusable name — ${problem} (pass --name to choose one)`);
    const finalDir = path.join(pluginsDir, folder);
    if (path.dirname(finalDir) !== pluginsDir) throw new Error(`refusing to install outside ${pluginsDir}`);

    const registry = readRegistry(pluginsDir);
    const record = registry.plugins[found.name] ?? Object.values(registry.plugins).find((r) => r?.folder === folder) ?? null;
    let trashPath = null;
    if (fs.existsSync(finalDir)) {
      // Unmanaged (hand-dropped, or never recorded) is someone's own work:
      // replacing it takes the explicit flag, and a copy is kept either way.
      if (!record && !force) {
        throw new Error(`plugins/${folder} already exists and was not installed by aipass — pass --force to replace it (a copy is kept in .trash)`);
      }
      trashPath = toTrash(pluginsDir, finalDir);
      log(`replaced plugins/${folder} — the previous copy is in ${trashPath}`);
    }

    // 4. Swap, then record. A crash between the two leaves a working plugin
    //    with a missing provenance line — the failure the registry is allowed.
    fs.renameSync(stageData, finalDir);
    registry.plugins[found.name] = {
      source: { type: plan.kind, ref: plan.ref },
      sha256: found.sha256,
      folder,
      installedAt: new Date().toISOString(),
      installedBy,
    };
    writeRegistry(pluginsDir, registry);
    return { ...found, folder, dir: finalDir, trashPath, previous: record, installed: registry.plugins[found.name] };
  } finally {
    discardStaging();
  }
}

/**
 * The second half of an install, where the live manager reloads and the rare
 * failure is contained: a plugin that validated in staging but throws in its
 * final home (path-dependent code) is rolled back — the previous version
 * returns from `.trash`, or a fresh folder is removed — and the error names
 * what happened. Returns the manager's refreshed details.
 */
export async function finalizeInstall(result, manager) {
  await manager.load();
  const folder = path.resolve(result.dir);
  const failed = manager.details().failed.find((f) => path.resolve(f.file).startsWith(folder + path.sep));
  if (!failed) return manager.details();

  const pluginsDir = path.dirname(folder);
  try {
    fs.rmSync(folder, { recursive: true, force: true });
    if (result.trashPath) fs.renameSync(result.trashPath, folder);
  } catch { /* the copy in trash stays for a manual restore */ }
  const registry = readRegistry(pluginsDir);
  if (result.previous) registry.plugins[result.name] = result.previous;
  else delete registry.plugins[result.name];
  writeRegistry(pluginsDir, registry);
  await manager.load();
  throw new Error(`the plugin failed to load at its final location (${failed.error}) — ${result.trashPath ? 'the previous version was restored' : 'nothing was left behind'}`);
}

/**
 * Remove a plugin. Managed plugins move to `.trash`; a hand-dropped file or
 * folder is refused without `force` — unmanaged work is the user's, and an
 * installer that deletes it is indistinguishable from a bug.
 */
export function removePlugin(name, { home = aipassHome(), pluginsDir = pluginsDirFor(home), force = false } = {}) {
  const registry = readRegistry(pluginsDir);
  const record = registry.plugins[name] ?? Object.values(registry.plugins).find((r) => r?.folder === name) ?? null;
  const folderName = record?.folder ?? name;
  const problem = nameProblem(folderName);
  if (problem) throw new Error(`not a usable plugin name — ${problem}`);

  const asFolder = path.join(pluginsDir, folderName);
  const asFile = path.join(pluginsDir, `${folderName}.mjs`);
  const target = fs.existsSync(asFolder) ? asFolder : fs.existsSync(asFile) ? asFile : null;
  if (!target) throw new Error(`no plugin named ${folderName} in ${pluginsDir}`);
  if (!record && !force) {
    throw new Error(`${folderName} was not installed by aipass — pass --force to move it to .trash`);
  }

  const trashed = toTrash(pluginsDir, target);
  for (const [key, rec] of Object.entries(registry.plugins)) {
    if (key === name || rec?.folder === folderName) delete registry.plugins[key];
  }
  writeRegistry(pluginsDir, registry);
  return { removed: true, name: folderName, trashed };
}

export default { planInstall, inspectSource, installSource, finalizeInstall, removePlugin, readRegistry, writeRegistry, decorateDetails, materializeEnabledList, stripFromEnabled, knownNames, pluginsDirFor, NONE_NAME };
