// A regression test for the bug that made the window stop answering: a settings
// value that breaks a run is now clamped at the one place all surfaces write.
//
// The same file also holds the guards around that one place: the write it
// makes has to be atomic for two writers, the values it hands out must not
// be able to hijack a prototype, and a settings file that cannot be read has
// to say so instead of quietly looking like an empty one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Settings, DEFAULTS } from '../harness/settings.mjs';
import { SkillLibrary } from '../harness/skills.mjs';
import { writeFileAtomic } from '../harness/atomic-write.mjs';
import { RulesStore, grantCovers } from '../harness/rules.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-clamp-'));

test('a save does not undo the change another surface made', () => {
  // The settings file is shared by the window, the CLI and the backend, and
  // two of them can write it. A save that merged into the copy the process
  // happened to be holding wrote every other key back unchanged — so a
  // project that had been moved landed back under its old path, and the
  // change was gone with no trace of who undid it.
  const dir = scratch();
  try {
    const s = new Settings(dir, 'settings.json');
    s.set({ mode: 'ask' });

    // Another surface writes the file: the CLI, a second backend, a backup
    // restored underneath this one.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    onDisk.projects = [{ name: 'moved', path: path.join(dir, 'moved') }];
    onDisk.root = path.join(dir, 'moved');
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(onDisk, null, 2));

    const next = s.set({ maxSteps: 12 });
    assert.equal(next.root, onDisk.root, 'the other surface’s change survived the save');
    assert.equal(next.projects.length, 1, 'and so did its project list');
    assert.equal(next.maxSteps, 12, 'and the save did what it was asked');

    // And it is on disk, not only in memory.
    const reread = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    assert.equal(reread.root, onDisk.root, 'the file says the same');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a value that would break a run is clamped, not stored', () => {
  // A negative step count is the case that justifies this: it would reach the
  // loop and stop a run before its first step. Zero is different — it is the
  // deliberate "no cap" and is stored as written.
  const dir = scratch();
  try {
    const s = new Settings(dir, 'settings.json');
    assert.equal(s.set({ maxSteps: 0 }).maxSteps, 0, 'zero means no cap, by design');
    assert.equal(s.set({ maxSteps: -5 }).maxSteps, 0, 'a negative count falls back to the default (no cap)');
    assert.equal(s.set({ maxSteps: 9_999 }).maxSteps, 200, 'and an absurd one is clamped to the ceiling');
    assert.equal(s.set({ compaction: { contextTokens: 10 } }).compaction.contextTokens, 1000, 'the budget has a floor');
    assert.equal(s.set({ compactAtPercent: 9_999 }).compactAtPercent, 100, 'the rotation share has a ceiling');
    assert.equal(s.set({ thinking: 'banana' }).thinking, 'low', 'an unknown thinking level falls back, never stores');
    assert.equal(s.set({ thinking: 'high' }).thinking, 'high', 'and a real level passes through');
    assert.equal(s.set({ temperature: 0.7 }).temperature, 0.7, 'a real temperature passes through');
    assert.equal(s.set({ temperature: 5 }).temperature, 2, 'an out-of-range temperature is clamped to the ceiling');
    assert.equal(s.set({ temperature: -1 }).temperature, 0, 'a negative temperature is clamped to the floor');
    assert.equal(s.set({ temperature: 'banana' }).temperature, null, 'nonsense falls back to the default, never a request');
    assert.equal(s.set({ temperature: null }).temperature, null, 'null means "the site decides"');
    assert.equal(s.set({ maxToolCalls: 0 }).maxToolCalls, 300, 'zero tool calls means the default, never zero');
    assert.equal(s.set({ maxToolCalls: 25 }).maxToolCalls, 25, 'a real tool-call cap passes through');
    assert.equal(s.set({ maxToolCalls: 9_999_999 }).maxToolCalls, 10_000, 'the tool-call cap has a ceiling');
    assert.equal(s.set({ maxWallClockMs: 1 }).maxWallClockMs, 10_000, 'the wall clock has a ten-second floor');
    assert.equal(s.set({ maxWallClockMs: 'banana' }).maxWallClockMs, 1_800_000, 'nonsense falls back to the default');
    assert.equal('chatUrl' in s.set({ chatUrl: 'javascript:alert(1)' }), false, 'a chat URL must be http(s)');
    // The declared check is one command line: a pasted second line must not
    // reach the checker prompt as another command.
    assert.equal(s.set({ verifyCommand: 'node check.mjs\necho not-a-check' }).verifyCommand, 'node check.mjs');
    assert.equal(s.set({ verifyCommand: '   ' }).verifyCommand, null, 'an empty declared check is "none"');
    assert.equal(s.set({ verifyCommand: 42 }).verifyCommand, null, 'a non-string is not a command');
    assert.equal(s.set({ requireCheck: 1 }).requireCheck, true);
    assert.equal(s.set({ requireCheck: 0 }).requireCheck, false);

    // A hand-edited file is clamped as it is read, not trusted.
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ maxSteps: -1, compaction: { contextTokens: 5 } }));
    const reloaded = new Settings(dir, 'settings.json');
    assert.equal(reloaded.values.maxSteps, 0);
    assert.equal(reloaded.values.compaction.contextTokens, 1000);

    // Sane values pass through untouched.
    const good = s.set({ maxSteps: 12, compaction: { contextTokens: 30_000, reserveTokens: 4_096 } });
    assert.equal(good.maxSteps, 12);
    assert.equal(good.compaction.contextTokens, 30_000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the user skills folder follows AIPASS_HOME, not the real home', () => {
  const home = scratch();
  const root = scratch();
  const prev = process.env.AIPASS_HOME;
  process.env.AIPASS_HOME = home;
  try {
    fs.mkdirSync(path.join(home, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(home, 'skills', 'probe.md'), '# probe\n');
    const lib = SkillLibrary.default({ root });
    assert.ok(
      lib.dirs.includes(path.resolve(home, 'skills')),
      `the user folder answers to AIPASS_HOME:\n${lib.dirs.join('\n')}`,
    );
    assert.equal(lib.has('probe'), true, 'and a skill in it is found');
  } finally {
    if (prev === undefined) delete process.env.AIPASS_HOME; else process.env.AIPASS_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a path-shaped key of the wrong shape is dropped, not saved to crash a surface', () => {
  // Each of these values reaches a path.resolve() or an iterable spread in
  // some surface — the window's project list, the backend's root pick, the
  // uploads folder, the skill library's dirs. A file that was hand-edited, or
  // written by an older build, must not take those surfaces down.
  const dir = scratch();
  try {
    const s = new Settings(dir, 'settings.json');
    const v = s.set({
      root: 42,
      projects: [{ path: 123 }, null, 'not-an-entry', { path: 'keep/me', name: 'kept' }],
      uploads: { nope: true },
      skillsDirs: 5,
      plugins: 'alpha',
    });
    assert.equal(v.root, null);
    assert.deepEqual(v.projects, [{ path: 'keep/me', name: 'kept' }]);
    assert.equal(v.uploads, null);
    assert.deepEqual(v.skillsDirs, []);
    assert.deepEqual(v.plugins, []);
    // projectList used to throw on the first junk entry — the window's first call.
    assert.deepEqual(s.projectList(), [{ name: 'kept', path: path.resolve('keep/me') }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------ the atomic write */

test('two writers to one file never lose an update and never throw', async () => {
  // The write used to land in one fixed temp name (`<file>.tmp`), so the
  // desktop backend's save and a CLI's save fought over it: the second
  // truncated the first's bytes, the first's rename moved the file away, and
  // the second's rename failed with ENOENT — an error that left the caller's
  // in-memory state stale and the file holding the WRONG payload.
  //
  // Two processes, because that is where the race lives: one process cannot
  // interleave with itself, the temp file and the rename are both sync.
  const dir = scratch();
  const scripts = scratch();
  try {
    const file = path.join(dir, 'settings.json');
    // The writer lives in its own directory: the test asserts that the
    // destination directory holds nothing but the destination.
    const worker = path.join(scripts, 'writer.mjs');
    fs.writeFileSync(worker, [
      `import { writeFileAtomic } from ${JSON.stringify(pathToFileURL(path.join(repo, 'aipass-bridge', 'harness', 'atomic-write.mjs')).href)};`,
      'const [file, tag, rounds] = process.argv.slice(2);',
      'for (let i = 0; i < Number(rounds); i += 1) {',
      '  writeFileAtomic(file, `${tag}:${i}\\n`);',
      '}',
    ].join('\n'));

    const write = (tag) => new Promise((resolve) => {
      const child = spawn(process.execPath, [worker, file, tag, '25'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let err = '';
      child.stderr.on('data', (chunk) => { err += chunk; });
      child.on('close', (code) => resolve({ code, err }));
    });

    const [a, b] = await Promise.all([write('A'), write('B')]);
    assert.equal(a.code, 0, `the first writer finished: ${a.err}`);
    assert.equal(b.code, 0, `the second writer finished: ${b.err}`);
    assert.equal(a.err, '', 'and neither of them reported an error');
    assert.equal(b.err, '');

    // The file holds ONE payload, whole: the payload a writer actually
    // wrote, never a mixture of the two and never a half-written file.
    const content = fs.readFileSync(file, 'utf8');
    assert.match(content, /^(A|B):\d+\n$/, `the file holds a whole payload: ${JSON.stringify(content)}`);

    // And no temp file survives the swap.
    assert.deepEqual(fs.readdirSync(dir), [path.basename(file)], 'the swap leaves no temp behind');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(scripts, { recursive: true, force: true });
  }
});

test('a name already taken at the temp path is never written through', (t) => {
  // `writeFileSync` opens with O_WRONLY|O_CREAT|O_TRUNC and FOLLOWS a link,
  // so a temp name that was already there — left by a crashed run, or
  // planted by another local user as a symlink or a hard link to a file of
  // theirs — turned the write into a write THROUGH it: the victim's content
  // was replaced by the settings, and nothing said so.
  const dir = scratch();
  try {
    const victim = path.join(dir, 'victim.txt');
    fs.writeFileSync(victim, 'the original\n');

    // A hard link is the same inode under a second name, so writing through
    // it replaces the victim's content. Every platform has them.
    const planted = path.join(dir, 'planted.tmp');
    fs.linkSync(victim, planted);
    assert.throws(() => writeFileAtomic(path.join(dir, 'settings.json'), 'the new payload\n', { temp: planted }),
      /EEXIST|exist/i, 'a name that is already taken is refused');
    assert.equal(fs.readFileSync(victim, 'utf8'), 'the original\n', 'and the file behind it is untouched');
    assert.equal(fs.existsSync(planted), true, 'and the name that was there is still there — it was not ours to remove');
    assert.equal(fs.existsSync(path.join(dir, 'settings.json')), false, 'nothing was published');

    // A symlink is the same story, where the OS lets a test make one.
    const link = path.join(dir, 'linked.tmp');
    try {
      fs.symlinkSync(victim, link, 'file');
    } catch {
      t.diagnostic('this machine does not let a test create a symlink; the hard link above is the same threat');
    }
    if (fs.existsSync(link)) {
      assert.throws(() => writeFileAtomic(path.join(dir, 'settings.json'), 'the new payload\n', { temp: link }),
        /EEXIST|exist/i, 'a symlink at the temp path is refused too');
      assert.equal(fs.readFileSync(victim, 'utf8'), 'the original\n', 'and the file behind it is untouched');
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'the symlink is still a symlink');
    }

    // The old predictable name is not the temp name any more, so a link
    // left there by an earlier build is not written through either.
    const file = path.join(dir, 'rules.json');
    const stale = `${file}.tmp`;
    fs.linkSync(victim, stale);
    writeFileAtomic(file, 'the new payload\n');
    assert.equal(fs.readFileSync(victim, 'utf8'), 'the original\n', 'a stale temp name is not written through');
    assert.equal(fs.readFileSync(file, 'utf8'), 'the new payload\n', 'and the write still lands');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the file ends up with the mode it was asked for', () => {
  // The mode only applies when the file is CREATED, and the umask takes bits
  // off it — so it is pinned after the bytes are in, or the credentials file
  // would be readable by the whole machine.
  const dir = scratch();
  try {
    const file = path.join(dir, 'credentials.json');
    writeFileAtomic(file, '{"key":"sk-test"}\n', { mode: 0o600 });
    assert.equal(fs.readFileSync(file, 'utf8'), '{"key":"sk-test"}\n', 'the bytes are the file');
    // POSIX modes are not a thing on windows — the ACLs are what is left
    // there, and the chmod is best effort there.
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'the key file is readable by its owner only');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------- the settings values */

test('a settings payload cannot hijack a prototype', () => {
  // `__proto__` in a settings file (or in an RPC `settings.set` payload) is
  // copied by a later `Object.assign` as a SET, and the inherited setter then
  // replaces the target's prototype — so the object a consumer was handed
  // could carry a prototype of somebody else's making.
  const dir = scratch();
  try {
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
      __proto__: { hijacked: 'from the file' },
      mode: 'auto',
      compaction: { __proto__: { hijacked: 'from the file' }, contextTokens: 30_000 },
    }));
    const s = new Settings(dir, 'settings.json');

    // The settings still load.
    assert.equal(s.get('mode'), 'auto', 'the file is read');
    assert.equal(s.get('compaction').contextTokens, 30_000, 'and so is the nested part');

    // And nothing it hands out carries the injected keys or a prototype of
    // somebody else's choosing.
    assert.equal(Object.getPrototypeOf(s.values), Object.prototype, 'the values have the ordinary prototype');
    assert.equal(s.values.hijacked, undefined, 'the injected key is not there');
    assert.equal(Object.getPrototypeOf(s.values.compaction), Object.prototype, 'nor is the nested part');
    assert.equal(s.values.compaction.hijacked, undefined);

    // The dangerous part is what a CONSUMER does with the object: an assign
    // is where the own `__proto__` key would do its damage.
    const copy = Object.assign({}, s.values);
    assert.equal(Object.getPrototypeOf(copy), Object.prototype, 'an assign onto a fresh object keeps the prototype');
    assert.equal(copy.hijacked, undefined, 'and copies no injected key');

    // The same through the write path — the payload is untrusted there too.
    const patch = JSON.parse('{"__proto__": {"hijacked": "from the payload"}}');
    const next = s.set(patch);
    assert.equal(Object.getPrototypeOf(next), Object.prototype, 'a payload cannot change the prototype');
    assert.equal(next.hijacked, undefined, 'and its keys are not handed out');
    assert.equal(Object.getPrototypeOf(Object.assign({}, next)), Object.prototype);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a settings file that cannot be read is surfaced, not silently defaulted', () => {
  // A missing file is the normal first run: the defaults apply and there is
  // nothing to say. A file that IS there and is broken is a real problem,
  // and it used to look exactly like an empty one — the app went quietly
  // back to `mode: 'ask'` with no rules, as if nothing had ever been set.
  const dir = scratch();
  try {
    const warnings = [];
    const log = (text) => warnings.push(text);

    // The normal first run: no file, no complaint.
    const fresh = new Settings(dir, 'settings.json', log);
    assert.deepEqual(warnings, [], 'a missing file is not a problem');
    assert.equal(fresh.get('mode'), 'ask', 'the defaults are in place');

    // A corrupt file: reported, and the safe defaults still apply.
    fs.writeFileSync(path.join(dir, 'settings.json'), '{ this is not json');
    const broken = new Settings(dir, 'settings.json', log);
    assert.equal(warnings.length, 1, 'the broken file is reported');
    assert.match(warnings[0], /settings\.json/, 'and the report names the file');
    assert.match(warnings[0], /default/i, 'and says the defaults are in use');
    assert.equal(broken.problems.length, 1, 'and it is kept on the object, to be shown');
    assert.equal(broken.get('mode'), 'ask', 'the safe defaults still apply');
    assert.equal(broken.get('allowRun'), false);

    // A file that is valid JSON but not a settings object is the same case.
    fs.writeFileSync(path.join(dir, 'settings.json'), '["not", "an", "object"]');
    const wrong = new Settings(dir, 'settings.json', log);
    assert.equal(warnings.length, 2, 'that is reported too');
    assert.equal(wrong.get('mode'), 'ask', 'and the defaults are in place');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the settings carry every value the applier reads', () => {
  // The applier in rpc.mjs reads the run's switches off the settings and
  // assigns them onto the harness options. A key that was not there read as
  // `undefined` and overwrote the harness's own default with nothing — how
  // the reading batch's `explore` and `parallelReads` went dead in the file:
  // the run sheet had them, the settings file's schema did not.
  const switches = ['searchI', 'attach', 'webScratch', 'recall', 'explore', 'parallelReads'];
  for (const key of switches) {
    assert.ok(key in DEFAULTS, `${key} is part of the settings`);
    assert.equal(typeof DEFAULTS[key], 'boolean', `${key} is a switch`);
  }
  const dir = scratch();
  try {
    const s = new Settings(dir, 'settings.json');
    for (const key of ['searchI', 'attach', 'webScratch']) assert.equal(s.get(key), false);
    for (const key of ['recall', 'explore', 'parallelReads']) assert.equal(s.get(key), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------------- the grants */

test('a shell grant is keyed by the command, not by the constant', () => {
  // Every RUN carries `arg: ''`, so a grant keyed by the argument was the
  // same grant for every command that would ever run: one "always" on a
  // benign command authorised all the others, for good, across restarts.
  const dir = scratch();
  try {
    const file = path.join(dir, 'rules.json');
    const root = path.join(dir, 'project');

    // An old rules.json: the blanket shell grant, as it was written.
    fs.writeFileSync(file, JSON.stringify({
      projects: { [path.resolve(root)]: { grants: [{ kind: 'run', arg: '' }, { kind: '', arg: '' }] } },
    }));
    const legacy = new RulesStore(file).forRoot(root);
    assert.equal(legacy.grants.length, 2, 'the old entries still load');
    assert.equal(grantCovers(legacy.grants, 'run', '', 'git status'), false,
      'a legacy blanket grant covers no command at all — the safe reading is "ask again"');
    assert.equal(grantCovers(legacy.grants, 'run', '', 'rm -rf /'), false);
    assert.equal(grantCovers(legacy.grants, '', ''), false, 'and it covers no kind either');

    // A grant written now carries the command's shape.
    const store = new RulesStore(file);
    store.addGrant(root, 'run', '', 'git status');
    const grants = store.forRoot(root).grants;
    const shell = grants.find((g) => g.kind === 'run' && g.fingerprint);
    assert.ok(shell, 'the shell grant is there');
    assert.equal(shell.arg, 'git status', 'and it says which command it is about');
    assert.equal(shell.head, 'git status', 'with the program and the verb under it');
    assert.equal(typeof shell.fingerprint, 'string', 'and it carries a fingerprint of it');

    // The old blanket grant is still in the file — it is not deleted, it just
    // answers nothing any more.
    assert.ok(grants.some((g) => g.kind === 'run' && !g.fingerprint), 'the old blanket grant is still there');
    assert.equal(grantCovers(grants, 'run', '', 'git status'), true, 'the granted command is covered');
    assert.equal(grantCovers(grants, 'run', '', 'git push'), false, 'another command of the same program is a new command');
    assert.equal(grantCovers(grants, 'run', '', 'rm -rf /'), false, 'and so is another program entirely');

    // The engine may hand the command over as the argument instead of the
    // body — a grant written that way is the same grant.
    assert.equal(grantCovers(grants, 'run', 'git status', ''), true, 'the command may arrive as the argument');

    // The path-shaped kinds keep the shape they always had: a grant for a
    // file is still a grant for that file.
    store.addGrant(root, 'write', 'src/config.ts');
    const withFile = store.forRoot(root).grants;
    assert.equal(grantCovers(withFile, 'write', 'src/config.ts'), true, 'the granted file is covered');
    assert.equal(grantCovers(withFile, 'write', 'src/other.ts'), false, 'one file, not the directory');
    assert.deepEqual(
      withFile.find((g) => g.kind === 'write'),
      { kind: 'write', arg: 'src/config.ts' },
      'and the stored shape of a file grant is unchanged',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
