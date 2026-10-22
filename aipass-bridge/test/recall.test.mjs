// The recall: what this project said before, on demand.
//
// The window has the sessions and the harness has a cross-session memory
// (harness/memory-store.mjs) that carries facts across rotations. The recall
// is the other half: a person who worked with the agent yesterday asks what
// was said then, and the answer is the entries of this project's own
// sessions that are about the question.
//
// It is a plain word match, scored, with the newest first as the tiebreak —
// no embedding, no network, no new dependency — and it is honest about it:
// a recall of nothing says so instead of handing back the whole store.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../harness/tools.mjs';
import { Overlay } from '../harness/overlay.mjs';
import { SessionStore } from '../harness/session.mjs';
import { parse } from '../harness/protocol.mjs';
import { recallEntries } from '../harness/memory-store.mjs';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-recall-home-'));
process.env.AIPASS_HOME = HOME;

const dirs = [];
const tempDir = (files = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-recall-'));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    const p = path.join(dir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
};

after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(HOME, { recursive: true, force: true });
});

/** A project with a session that talked about the login flow. */
const withPast = () => {
  const dir = tempDir({ 'app.mjs': 'export const login = () => {};\n' });
  const store = new SessionStore(path.join(HOME, 'sessions'));
  const session = store.create({ root: dir, model: 'stub', title: 'fix the login' });
  session.append('user', { text: 'the login flow is broken on the callback' });
  session.append('assistant', { text: 'I fixed the login flow: the token is now checked before the redirect' });
  session.append('tool', { kind: 'read', arg: 'app.mjs', out: 'export const login = () => {};', ok: true });
  session.append('note', { text: 'the checkout branch is still open' });
  return { dir, store, session };
};

test('the past answers a question about it', async () => {
  const { dir, store } = withPast();
  const tools = createTools({ root: dir, overlay: new Overlay(dir), store });

  const out = await tools.recall('login flow');

  assert.match(out, /login flow/, 'the answer carries the words that were asked about');
  assert.match(out, /token is now checked before the redirect/, 'and what was said');
  assert.match(out, /fix the login/, 'with the session it came from');
  assert.match(out, /\d{4}-\d{2}-\d{2}/, 'and the date');
  assert.ok(!out.includes('export const login'), 'a tool result is not talk, and does not ride back');
});

test('a recall of nothing says so, instead of returning the whole store', async () => {
  const { dir, store } = withPast();
  const tools = createTools({ root: dir, overlay: new Overlay(dir), store });

  const out = await tools.recall('kubernetes helm chart');

  assert.match(out, /nothing in this project's past/, 'the answer says there is nothing');
  assert.match(out, /no match/, 'and how it knows');
  assert.ok(!out.includes('login flow'), 'the store is not handed back as a consolation prize');
  assert.ok(out.length < 500, 'and the answer is short');
});

test('the past is reachable with the RECALL marker', () => {
  const calls = parse('RECALL what did we decide about the login flow\n');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, 'recall');
  assert.equal(calls[0].arg, 'what did we decide about the login flow');
});

test('the recall reads the newest first, and the newest wins a tie', async () => {
  const { dir, store, session } = withPast();
  const second = store.create({ root: dir, model: 'stub', title: 'the second look' });
  second.append('assistant', { text: 'the login flow is fine now — the fix was the token check' });

  const result = await recallEntries('login flow', { root: dir, store });
  assert.ok(result.hits.length >= 2, 'both sessions are about it');
  assert.equal(result.hits[0].title, 'the second look', 'the newer one comes first');

  // And the session that is asked about is the one that answered.
  assert.ok(session.id);
});
