// Disaster recovery, drilled (docs/DATA_FORMATS.md "Recovery"): a backup here
// is a copy of the home folder, and a restore is copying it back. These tests
// run the drill on a throwaway home — copy it into a second environment and
// prove the readers (sessions, settings, token) see the same thing there —
// including the cross-machine case where the project lives at a new path and
// relocate has to reconnect the path-keyed stores.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../harness/session.mjs';
import { Settings } from '../harness/settings.mjs';
import { RulesStore } from '../harness/rules.mjs';
import { loadMemory, saveMemory } from '../harness/memory-store.mjs';
import { relocateProject } from '../harness/relocate.mjs';
import { loadOrMintToken, authorized, tokenPath } from '../harness/authtoken.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-drill-'));
/** A destination under an existing parent that cpSync will create. */
const freshDir = (name) => path.join(tmp(), name);

const buildHome = () => {
  const home = tmp();
  const store = new SessionStore(path.join(home, 'sessions'));
  const project = path.join(home, 'project');
  const kept = store.create({ root: project, model: 'restore-model', title: 'backup me' });
  kept.append('user', { text: 'hello' });
  kept.append('assistant', { text: 'hi' });
  const dropped = store.create({ root: project, model: 'restore-model', title: 'deleted later' });
  dropped.append('user', { text: 'this one goes away' });
  store.remove(dropped.id); // a deletion that must not resurrect in the copy
  const settings = new Settings(home);
  settings.set({ model: 'restore-model', mode: 'auto' });
  const token = loadOrMintToken(home);
  return { home, sessionId: kept.id, token };
};

test('the drill: a copied home restores into a second environment and reads the same', () => {
  const { home, sessionId } = buildHome();
  const backup = freshDir('aipass-backup');
  fs.cpSync(home, backup, { recursive: true }); // the backup: a folder copy
  fs.rmSync(home, { recursive: true, force: true }); // the machine dies

  const restored = freshDir('restored'); // the new environment
  fs.cpSync(backup, restored, { recursive: true });

  const store = new SessionStore(path.join(restored, 'sessions'));
  const listed = store.list();
  assert.equal(listed.length, 1, 'the deleted session stays deleted in the copy');
  assert.equal(listed[0].id, sessionId);
  const s = store.load(sessionId);
  assert.deepEqual(s.entries.map((e) => e.type), ['user', 'assistant'], 'completed turns survive');

  const settings = new Settings(restored);
  assert.equal(settings.get('model'), 'restore-model');
  assert.equal(settings.get('mode'), 'auto');
});

test('the drill: the token travels with the backup — identity is the folder, not the machine', () => {
  const prevToken = process.env.AIPASS_TOKEN;
  const prevFlag = process.env.AIPASS_REQUIRE_AUTH;
  delete process.env.AIPASS_TOKEN;
  process.env.AIPASS_REQUIRE_AUTH = '1';
  try {
    const { home, token } = buildHome();
    const restored = freshDir('restored');
    fs.cpSync(home, restored, { recursive: true });

    assert.equal(loadOrMintToken(restored), token, 'the same token, not a fresh mint');
    assert.equal(authorized({ headers: { authorization: `Bearer ${token}` } }, restored), true, 'the restored home accepts it');
    assert.equal(authorized({ headers: { authorization: 'Bearer wrong' } }, restored), false, 'and still refuses anything else');

    fs.rmSync(tokenPath(restored));
    assert.notEqual(loadOrMintToken(restored), token, 'deleting the restored token revokes it, the same as at home');
  } finally {
    if (prevToken === undefined) delete process.env.AIPASS_TOKEN; else process.env.AIPASS_TOKEN = prevToken;
    if (prevFlag === undefined) delete process.env.AIPASS_REQUIRE_AUTH; else process.env.AIPASS_REQUIRE_AUTH = prevFlag;
  }
});

test('the drill: a project that lives somewhere new is reconnected by relocate', () => {
  // The cross-machine half of the drill. The home copies over fine, but the
  // project it knew now sits at a different absolute path (another username,
  // another disk) — and sessions, memory and rules are all keyed by that path.
  const home = tmp();
  const oldProject = path.join(home, 'project');
  fs.mkdirSync(oldProject); // the project itself, so the drill can unpack it elsewhere
  const store = new SessionStore(path.join(home, 'sessions'));
  const kept = store.create({ root: oldProject, model: 'restore-model', title: 'follow me' });
  kept.append('user', { text: 'hello' });
  saveMemory(oldProject, ['the deploy target is staging'], path.join(home, 'memory'));
  new RulesStore(path.join(home, 'rules.json')).setRules(oldProject, [{ pattern: 'vendor/**', decision: 'deny' }]);
  new Settings(home).addProject(oldProject);

  // The restore, then the move: the project is unpacked at a new path.
  const restored = freshDir('restored');
  fs.cpSync(home, restored, { recursive: true });
  const newProject = path.join(restored, 'work', 'app');
  fs.mkdirSync(path.join(restored, 'work'));
  fs.renameSync(path.join(restored, 'project'), newProject);

  // Before the remap the new path is a stranger: an empty picker, no facts,
  // no rules — while every byte still sits on disk under the old spelling.
  const restoredStore = new SessionStore(path.join(restored, 'sessions'));
  const memDir = path.join(restored, 'memory');
  assert.equal(restoredStore.list(newProject).length, 0);
  assert.deepEqual(loadMemory(newProject, memDir), []);

  const out = relocateProject({ from: oldProject, to: newProject, home: restored });
  assert.equal(out.sessions.moved, 1);
  assert.equal(restoredStore.list(newProject)[0].id, kept.id, 'the conversation is back in the picker');
  assert.deepEqual(loadMemory(newProject, memDir), ['the deploy target is staging'], 'the facts followed');
  assert.equal(new RulesStore(path.join(restored, 'rules.json')).forRoot(newProject).rules.length, 1, 'the rules apply again');
  assert.equal(new Settings(restored).get('root'), path.resolve(newProject), 'the window opens on the new path');
});
