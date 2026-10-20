// The generated SKILL index names each library by ROLE, not by position.
//
// The old labels compared a directory to dirs[0] for "project", so the moment
// the workspace had no `.aipass/skills` folder — the common case — the user's
// home library was reported as the project's. A label that lies about where a
// playbook lives is worse than no label: it is how the model decides which
// copy wins when two libraries carry the same name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SkillLibrary } from '../harness/skills.mjs';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-skills-'));

test('a missing project folder does not relabel the user library as the project', () => {
  const home = scratch();
  const root = scratch();          // deliberately no .aipass/skills of its own
  const repoDir = scratch();
  const prev = process.env.AIPASS_HOME;
  process.env.AIPASS_HOME = home;
  try {
    fs.mkdirSync(path.join(home, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(home, 'skills', 'user-note.md'), '# user\n');
    fs.writeFileSync(path.join(repoDir, 'repo-note.md'), '# repo\n');

    const text = SkillLibrary.default({ root, repoDir }).index();
    assert.match(text, /user-note {2}\(user\)/, text);
    assert.match(text, /repo-note {2}\(built-in\)/, text);
  } finally {
    if (prev === undefined) delete process.env.AIPASS_HOME; else process.env.AIPASS_HOME = prev;
    for (const d of [home, root, repoDir]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('a project folder that exists stays the project, and wins the shared name', () => {
  const home = scratch();
  const root = scratch();
  const prev = process.env.AIPASS_HOME;
  process.env.AIPASS_HOME = home;
  try {
    fs.mkdirSync(path.join(home, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(home, 'skills', 'shared.md'), '# user copy\n');
    fs.mkdirSync(path.join(root, '.aipass', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(root, '.aipass', 'skills', 'shared.md'), '# project copy\n');
    fs.writeFileSync(path.join(root, '.aipass', 'skills', 'only-here.md'), '# p\n');

    const lib = SkillLibrary.default({ root });
    const text = lib.index();
    assert.match(text, /shared {2}\(project\)/, text);
    assert.match(text, /only-here {2}\(project\)/, text);
    // First match wins: a load resolves to the project copy.
    assert.equal(lib.load('shared').text, '# project copy\n');
  } finally {
    if (prev === undefined) delete process.env.AIPASS_HOME; else process.env.AIPASS_HOME = prev;
    for (const d of [home, root]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('the curated index is a preamble — a part added later is still named', () => {
  // The curated index.md used to BE the index, so a part added yesterday
  // stayed invisible until someone remembered to edit the prose. A playbook
  // that exists but is never named is a playbook that never runs.
  const home = scratch();
  const root = scratch();
  const prev = process.env.AIPASS_HOME;
  process.env.AIPASS_HOME = home;
  try {
    fs.mkdirSync(path.join(home, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(home, 'skills', 'index.md'), 'the library, described by a person\n');
    fs.writeFileSync(path.join(home, 'skills', 'plan-01.md'), '# plan\n');

    const lib = SkillLibrary.default({ root });
    const text = lib.index();
    assert.match(text, /described by a person/, 'the curated text leads');
    assert.match(text, /plan-01/, 'and the list of what is on disk follows it');

    // A part dropped in while the app is open: the folders are read on every
    // call, so the next read names it — no restart, no prose to edit.
    fs.writeFileSync(path.join(home, 'skills', 'debug-01.md'), '# debug\n');
    const later = lib.index();
    assert.match(later, /debug-01/, 'a new part shows up on the next read');
    assert.match(later, /described by a person/, 'the preamble is still there');
  } finally {
    if (prev === undefined) delete process.env.AIPASS_HOME; else process.env.AIPASS_HOME = prev;
    for (const d of [home, root]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('one order for every surface: a configured folder wins over the project one', () => {
  // The window and the CLI used to disagree about where a configured folder
  // sits, so a name in two libraries loaded a different file depending on who
  // asked. The settings file is the one source of truth both read.
  const home = scratch();
  const root = scratch();
  const configured = scratch();
  const prev = process.env.AIPASS_HOME;
  process.env.AIPASS_HOME = home;
  try {
    fs.mkdirSync(path.join(home, 'skills'), { recursive: true });
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ skillsDirs: [configured] }));
    fs.writeFileSync(path.join(configured, 'shared.md'), '# configured copy\n');
    fs.mkdirSync(path.join(root, '.aipass', 'skills'), { recursive: true });
    fs.writeFileSync(path.join(root, '.aipass', 'skills', 'shared.md'), '# project copy\n');

    const lib = SkillLibrary.default({ root });
    assert.equal(lib.load('shared').text, '# configured copy\n', 'the folder a person configured wins');
    assert.match(lib.index(), /shared {2}\(configured\)/, 'and it says so, not "built-in"');
  } finally {
    if (prev === undefined) delete process.env.AIPASS_HOME; else process.env.AIPASS_HOME = prev;
    for (const d of [home, root, configured]) fs.rmSync(d, { recursive: true, force: true });
  }
});
