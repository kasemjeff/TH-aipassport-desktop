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
// A source is a path, an https URL, a git repository or an npm package.
//
// Three rules the code keeps:
//   - Plan and inspect run no plugin code. Validation does (an ESM import runs
//     top-level code), so it happens only after the caller asked the person.
//     Fetching is not running: git and npm are asked for bytes, with their own
//     install scripts switched off.
//   - Nothing is ever deleted: a replaced version moves to `.trash`, and a
//     hand-dropped plugin is only replaced with an explicit force.
//   - The registry (`.registry.json`) records provenance and can be deleted at
//     any time without breaking loading — it answers "where did this come
//     from", it does not gate anything.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { aipassHome } from './settings.mjs';
import { PluginManager } from './plugins.mjs';

/** A single-file pull is source, not media; 1 MB is generous for one module. */
export const MAX_URL_BYTES = 1024 * 1024;

/**
 * A fetched tree is bigger than a module — a repository carries its history
 * of docs, tests and examples. The cap keeps a fetch from filling the disk
 * before the person saw what it holds.
 */
export const MAX_TREE_BYTES = 8 * 1024 * 1024;

/** A full commit hash: `--branch` takes a branch or a tag, not a sha. */
const FULL_SHA = /^[0-9a-f]{40}$/i;

/**
 * A failure that knows the step it happened in.
 *
 * The window shows the step, so a refusal says which door closed — the fetch
 * failed, the plugin did not validate, the name was taken — instead of only
 * that something did.
 */
const stageError = (stage, message) => Object.assign(new Error(message), { stage });


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
 * `github:owner/repo[#rev][::path:sub]` and `git+<url>[#rev]`.
 *
 * The github form is the shape npm uses, so a spec that works in a
 * package.json works here. A revision is a branch, a tag or a full commit —
 * and a branch moves, which is why the hash of what it pointed at is what the
 * person actually consents to.
 */
function parseGitSource(raw) {
  const body = raw.startsWith('github:') ? raw.slice('github:'.length) : raw.slice('git+'.length);
  const [repoPart, subPart] = body.split('::path:');
  const [repo, rev] = repoPart.split('#');
  let url;
  if (raw.startsWith('github:')) {
    const [owner, name] = repo.split('/');
    if (!owner || !name) throw stageError('plan', `not a github source: ${raw} — expected github:owner/repo`);
    url = `https://github.com/${owner}/${name}.git`;
  } else {
    url = repo;
    // file:// is a local repository — a mirror on this machine, and what the
    // tests clone. The rest are the transports a person can actually reach.
    if (!/^(https?|ssh|git|file):\/\//i.test(url)) {
      throw stageError('plan', `not a git source: ${raw} — expected git+https://… or git+ssh://…`);
    }
  }
  return { url, rev: rev || null, subdir: subPart || null };
}

/** `npm:<package>[@<version>]`, scoped packages included. */
function parseNpmSource(raw) {
  const body = raw.slice('npm:'.length);
  // A local folder is a spec too: `npm:./my-plugin` — npm installs it like
  // any other dependency, and it lands under the name its package.json
  // declares, not under the path it was given as.
  const local = /^[./\\]/.test(body) || /^[a-z]:[\\/]/i.test(body);
  // The version separator is the LAST @: in `@scope/pkg` the only @ is the
  // scope's, in `@scope/pkg@1.2.3` it is the version's.
  const at = body.lastIndexOf('@');
  const pkg = !local && at > 0 ? body.slice(0, at) : body;
  const version = !local && at > 0 ? body.slice(at + 1) || null : null;
  if (!pkg) throw stageError('plan', `not an npm source: ${raw} — expected npm:<package>`);
  return { pkg, version, local };
}

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
  if (!raw) throw stageError('plan', 'no source given — a path, a folder, an https:// URL, a git repository or an npm package');

  // A git or npm spec is read before the URL branch: `git+ssh://…` looks like
  // a URL to that branch and is not one.
  if (/^npm:/i.test(raw)) return { kind: 'npm', ...parseNpmSource(raw), ref: raw };
  if (/^github:/i.test(raw) || /^git\+/i.test(raw)) return { kind: 'git', ...parseGitSource(raw), ref: raw };

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url;
    try { url = new URL(raw); } catch { throw stageError('plan', `not a URL: ${raw}`); }
    if (url.protocol === 'http:') {
      if (!isLoopbackHost(url.hostname)) throw stageError('plan', 'http:// is refused (a plain link can be rewritten in transit) — use https://, or http on 127.0.0.1/localhost for a local test host');
    } else if (url.protocol !== 'https:') {
      throw stageError('plan', `unsupported scheme ${url.protocol}// — use https:// or a local path`);
    }
    return { kind: 'url', ref: url.href };
  }

  const expanded = raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : raw;
  return { kind: 'path', ref: path.resolve(base, expanded) };
}

async function fetchBytes(ref, fetchImpl) {
  const res = await fetchImpl(ref, { redirect: 'follow' });
  if (!res.ok) throw stageError('fetch', `download failed: HTTP ${res.status}`);
  const declared = Number(res.headers?.get?.('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_URL_BYTES) {
    throw stageError('fetch', `the file is ${Math.round(declared / 1024)} KB — over the ${MAX_URL_BYTES / 1024} KB single-file cap`);
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MAX_URL_BYTES) {
    throw stageError('fetch', `the file is ${Math.round(bytes.length / 1024)} KB — over the ${MAX_URL_BYTES / 1024} KB single-file cap`);
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

/** The bytes of a tree, counted without blocking the backend's event loop. */
async function treeBytes(files) {
  let size = 0;
  for (const file of files) {
    try { size += (await fs.promises.stat(file)).size; } catch { /* gone under us */ }
  }
  return size;
}

/**
 * Run a tool with an argv array — never a shell string.
 *
 * git and npm are programs the machine already has, not packages this project
 * ships: a repository that installs no dependencies still needs a way to
 * fetch a plugin.
 */
function run(cmd, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => reject(stageError('fetch', `${cmd} could not run: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) { resolve(); return; }
      const first = err.trim().split('\n').filter(Boolean)[0] ?? '';
      reject(stageError('fetch', `${cmd} ${args[0]} failed (exit ${code})${first ? `: ${first}` : ''}`));
    });
  });
}

/**
 * A shallow clone into `dest`.
 *
 * A branch moves, so what the clone fetched is the thing the person consents
 * to — the hash of the entry file, compared again at install time. A full
 * commit hash needs its own fetch: `--branch` takes a branch or a tag, not a
 * sha.
 */
async function fetchGit(plan, dest) {
  const args = ['clone', '--depth', '1', '--quiet'];
  if (plan.rev && !FULL_SHA.test(plan.rev)) args.push('--branch', plan.rev);
  args.push(plan.url, dest);
  await run('git', args);
  if (plan.rev && FULL_SHA.test(plan.rev)) {
    await run('git', ['fetch', '--depth', '1', '--quiet', 'origin', plan.rev], { cwd: dest });
    await run('git', ['checkout', '--quiet', 'FETCH_HEAD'], { cwd: dest });
  }
}

/**
 * The npm command, as this machine can run it.
 *
 * On Windows npm is a `.cmd` shim, and neither spawn nor execFile can run one
 * without a shell — so the CLI behind the shim is run with node directly, the
 * arguments intact and no shell string anywhere. Where npm lives is asked
 * from node itself, which is always next to it.
 */
function npmCommand() {
  const direct = process.env.npm_execpath;
  if (direct && fs.existsSync(direct)) return { cmd: process.execPath, args: [direct] };
  const candidates = [
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/lib/node_modules/npm/bin/npm-cli.js',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { cmd: process.execPath, args: [candidate] };
  }
  // Last resort: the shim itself, which a shell would have to run.
  return { cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: [] };
}

/**
 * `npm install` into a scratch prefix, with the scripts off.
 *
 * `--ignore-scripts` is the point: a package's install scripts are code, and
 * this installer's promise is that nothing runs before the person says yes.
 * The package's own dependencies come along, so a plugin that imports one
 * still works from its final home.
 */
async function fetchNpm(plan, prefix) {
  const spec = plan.version ? `${plan.pkg}@${plan.version}` : plan.pkg;
  const npm = npmCommand();
  await run(npm.cmd, [...npm.args, 'install', '--ignore-scripts', '--no-save', '--no-audit', '--no-fund', '--prefix', prefix, spec]);
  // A local folder is installed under the name its package.json declares.
  const name = plan.local ? await npmPackageName(plan.pkg) : plan.pkg;
  return { dir: path.join(prefix, 'node_modules', ...name.split('/')), name };
}

/** The name a local package declares — the folder npm installed it under. */
async function npmPackageName(dir) {
  try {
    const raw = JSON.parse(await fs.promises.readFile(path.join(dir, 'package.json'), 'utf8'));
    if (raw?.name) return String(raw.name);
  } catch { /* fall back to the folder name */ }
  return path.basename(path.resolve(dir));
}

/**
 * Copy a package's dependencies beside the plugin.
 *
 * The package's own entry is left out: npm links a local folder rather than
 * copying it, and a link in the plugins directory would point back to
 * wherever it was written. Links inside the dependencies are followed, so the
 * final home holds real files.
 */
async function copyDependencies(modules, target, name) {
  await fs.promises.mkdir(target, { recursive: true });
  const scope = name.includes('/') ? name.split('/')[0] : null;
  const leaf = scope ? name.split('/')[1] : null;
  for (const entry of await fs.promises.readdir(modules, { withFileTypes: true })) {
    if (!scope && entry.name === name) continue;
    if (scope && entry.name === scope) {
      const scopeDir = path.join(modules, scope);
      for (const inner of await fs.promises.readdir(scopeDir, { withFileTypes: true })) {
        if (inner.name === leaf) continue;
        await fs.promises.cp(path.join(scopeDir, inner.name), path.join(target, scope, inner.name), { recursive: true, dereference: true });
      }
      continue;
    }
    await fs.promises.cp(path.join(modules, entry.name), path.join(target, entry.name), { recursive: true, dereference: true });
  }
}

/**
 * Fetch a git or npm source into `dest`.
 *
 * `dest` ends up holding the plugin's own files — and, for npm, the
 * dependencies installed beside it — so validation loads the same shape
 * production will.
 */
async function fetchSource(plan, dest, scratch) {
  if (plan.kind === 'git') {
    const clone = path.join(scratch, 'clone');
    await fs.promises.mkdir(scratch, { recursive: true });
    await fetchGit(plan, clone);
    const root = plan.subdir ? path.join(clone, ...plan.subdir.split('/')) : clone;
    if (!fs.existsSync(root)) throw stageError('fetch', `the repository has no ${plan.subdir} folder`);
    await fs.promises.cp(root, dest, { recursive: true });
  } else {
    const prefix = path.join(scratch, 'npm');
    await fs.promises.mkdir(prefix, { recursive: true });
    const { dir: pkgDir, name } = await fetchNpm(plan, prefix);
    if (!fs.existsSync(pkgDir)) throw stageError('fetch', `npm did not install ${plan.pkg}`);
    // npm links a local folder rather than copying it; the plugin's final
    // home holds real files, not a link back to wherever it was written.
    const real = await fs.promises.realpath(pkgDir);
    await fs.promises.cp(real, dest, { recursive: true });
    // The dependencies go beside the plugin so an import inside it resolves
    // from its final home.
    await copyDependencies(path.join(prefix, 'node_modules'), path.join(dest, 'node_modules'), name);
  }
  const files = await walkFiles(dest);
  const size = await treeBytes(files);
  if (size > MAX_TREE_BYTES) {
    throw stageError('fetch', `the fetched plugin is ${Math.round(size / 1024)} KB — over the ${Math.round(MAX_TREE_BYTES / 1024)} KB cap for a fetched source`);
  }
  return dest;
}

/**
 * What a tree holds — size, file count and the hash of the entry file.
 *
 * The hash is the entry's, because that is the file the loader records and
 * the registry compares.
 */
async function describeTree(root, label) {
  const entry = path.join(root, 'plugin.mjs');
  if (!fs.existsSync(entry)) throw stageError('plan', `${label} has no plugin.mjs — a plugin folder needs one`);
  const entryBytes = await fs.promises.readFile(entry);
  const files = await walkFiles(root);
  const size = await treeBytes(files);
  return {
    size,
    sha256: sha256(entryBytes),
    entry: 'plugin.mjs',
    hasPackageJson: fs.existsSync(path.join(root, 'package.json')),
    files: files.length,
  };
}

/**
 * What the source holds — size and content hash, and **no execution**. This is
 * what a person confirms against: the hash of the bytes that will run, known
 * before they run. A folder's hash is its entry file's (plugin.mjs), because
 * that is the file the loader records and the registry compares.
 *
 * A git or npm source is fetched to answer the question, because its bytes
 * live somewhere else — but fetching is not running: git and npm are asked
 * for files, with npm's install scripts switched off, and the scratch tree is
 * swept when the report is done.
 */
export async function inspectSource(source, { base = process.cwd(), fetchImpl = fetch } = {}) {
  const plan = planInstall(source, { base });
  if (plan.kind === 'url') {
    const bytes = await fetchBytes(plan.ref, fetchImpl);
    return { kind: 'url', ref: plan.ref, size: bytes.length, sha256: sha256(bytes), entry: 'plugin.mjs' };
  }
  if (plan.kind === 'git' || plan.kind === 'npm') {
    const scratch = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'aipass-plugin-'));
    try {
      const root = await fetchSource(plan, path.join(scratch, 'plugin'), path.join(scratch, 'fetch'));
      return { kind: plan.kind, ref: plan.ref, ...(await describeTree(root, plan.ref)) };
    } finally {
      await fs.promises.rm(scratch, { recursive: true, force: true });
    }
  }
  const st = fs.statSync(plan.ref);
  if (st.isFile()) {
    if (!plan.ref.endsWith('.mjs')) throw stageError('plan', `not a plugin file: ${plan.ref} — a single-file plugin is an .mjs module`);
    const bytes = fs.readFileSync(plan.ref);
    return { kind: 'path', ref: plan.ref, size: bytes.length, sha256: sha256(bytes), entry: path.basename(plan.ref) };
  }
  if (st.isDirectory()) {
    return { kind: 'path', ref: plan.ref, ...(await describeTree(plan.ref, plan.ref)) };
  }
  throw stageError('plan', `nothing to install at ${plan.ref}`);
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
 * What `plugin update <name>` re-fetches: the recorded source of a managed
 * plugin. The refusal is named, because update on a hand-dropped plugin is a
 * real question — there is nothing recorded to re-fetch, and guessing a path
 * would be worse than saying so.
 */
export function updateSourceFor(registry, name) {
  const record = registry?.plugins?.[name];
  if (!record) {
    throw new Error(`no recorded source for ${name} — it was not installed by aipass; install it explicitly with a source`);
  }
  const ref = record.source?.ref;
  if (!ref) throw new Error(`the registry record for ${name} has no source to re-fetch`);
  return { name, source: { ...record.source }, sha256: record.sha256 ?? null, installedAt: record.installedAt ?? null };
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
  const base = path.basename(target);
  let dest = path.join(trash, `${base}-${stamp}`);
  // Two swaps inside one millisecond would collide on the stamp; the second
  // gets a counter rather than a failure.
  for (let n = 2; fs.existsSync(dest); n++) dest = path.join(trash, `${base}-${stamp}-${n}`);
  fs.renameSync(target, dest);
  pruneTrash(pluginsDir, base);
  return dest;
}

/**
 * One previous version per name: the copy just moved in stays, older
 * timestamped copies of the same name go. The trash is a convenience for "I
 * replaced the wrong thing", not a history — the registry is provenance, and
 * a plugin folder can be large enough that keeping every generation is not a
 * favor.
 */
function pruneTrash(pluginsDir, base) {
  const trash = trashDirFor(pluginsDir);
  const prefix = `${base}-`;
  let entries;
  try { entries = fs.readdirSync(trash); } catch { return; }
  const mine = entries
    .filter((n) => n.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}T[0-9A-Za-z-]+$/.test(n.slice(prefix.length)))
    .sort(); // the stamp is ISO, so lexicographic order is chronological
  for (const old of mine.slice(0, -1)) {
    try { fs.rmSync(path.join(trash, old), { recursive: true, force: true }); } catch { /* keep whatever is left */ }
  }
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
        throw stageError('fetch', `the file changed since it was inspected (expected ${expectedSha256.slice(0, 12)}…, got ${got.slice(0, 12)}…) — inspect it again`);
      }
      fs.writeFileSync(path.join(stageData, 'plugin.mjs'), bytes);
    } else if (plan.kind === 'path') {
      const st = fs.statSync(plan.ref);
      if (st.isDirectory()) {
        await fs.promises.cp(plan.ref, stageData, { recursive: true });
      } else {
        if (!plan.ref.endsWith('.mjs')) throw stageError('plan', `not a plugin file: ${plan.ref} — a single-file plugin is an .mjs module`);
        fs.copyFileSync(plan.ref, path.join(stageData, 'plugin.mjs'));
      }
      const entry = path.join(stageData, 'plugin.mjs');
      if (!fs.existsSync(entry)) throw stageError('plan', `${plan.ref} has no plugin.mjs — a plugin folder needs one`);
      if (expectedSha256 && sha256(fs.readFileSync(entry)) !== expectedSha256) {
        throw stageError('fetch', 'the file changed since it was inspected — inspect it again');
      }
    } else {
      // A git or npm source is fetched into the same staging layout, so the
      // validation below loads the shape production will.
      await fetchSource(plan, stageData, path.join(stageRoot, 'fetch'));
      const entry = path.join(stageData, 'plugin.mjs');
      if (!fs.existsSync(entry)) throw stageError('plan', `${plan.ref} has no plugin.mjs — a fetched plugin needs one at its root`);
      if (expectedSha256 && sha256(await fs.promises.readFile(entry)) !== expectedSha256) {
        throw stageError('fetch', 'the source changed since it was inspected — inspect it again');
      }
    }

    // 2. Validate by loading the staged copy with the real loader. This is
    //    the step that executes top-level code; it runs here, after consent,
    //    in a directory the loader would accept in production.
    const probe = new PluginManager({ dir: stageRoot, settings: null, events: null, log: () => {} });
    const details = await probe.load();
    if (!details.loaded.length) {
      throw stageError('validate', details.failed[0]?.error ?? 'not a plugin: the file needs a default export with setup(ctx)');
    }
    const found = details.loaded[0];

    // 3. Where it lands. The declared name is the folder, because the enabled
    //    list, the window and the registry all speak that name.
    const folder = (name ?? found.name)?.trim();
    const problem = nameProblem(folder);
    if (problem) throw stageError('name', `the plugin declares an unusable name — ${problem} (pass --name to choose one)`);
    const finalDir = path.join(pluginsDir, folder);
    if (path.dirname(finalDir) !== pluginsDir) throw stageError('name', `refusing to install outside ${pluginsDir}`);

    const registry = readRegistry(pluginsDir);
    const record = registry.plugins[found.name] ?? Object.values(registry.plugins).find((r) => r?.folder === folder) ?? null;
    let trashPath = null;
    if (fs.existsSync(finalDir)) {
      // Unmanaged (hand-dropped, or never recorded) is someone's own work:
      // replacing it takes the explicit flag, and a copy is kept either way.
      if (!record && !force) {
        throw stageError('swap', `plugins/${folder} already exists and was not installed by aipass — pass --force to replace it (a copy is kept in .trash)`);
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
  throw stageError('finalize', `the plugin failed to load at its final location (${failed.error}) — ${result.trashPath ? 'the previous version was restored' : 'nothing was left behind'}`);
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

export default { planInstall, inspectSource, installSource, finalizeInstall, removePlugin, readRegistry, writeRegistry, decorateDetails, materializeEnabledList, stripFromEnabled, knownNames, updateSourceFor, pluginsDirFor, NONE_NAME };
