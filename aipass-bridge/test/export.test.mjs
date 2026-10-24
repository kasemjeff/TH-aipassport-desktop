// The export of a session: the markdown, the HTML page, and the tree.
//
// The contract is that a transcript is never quietly shortened: every entry
// type in the file has to be in the export, and the HTML has to be a page
// that cannot run anything the model said.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../harness/session.mjs';
import { toMarkdown, toHtml, tree } from '../harness/export.mjs';
import { createSessionMethods } from '../harness/rpc/session.mjs';

const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-export-'));
  scratch.push(dir);
  return dir;
};

// The scratch trees this file makes go when the process does: a run that left
// one behind per test filled the temp directory with litter nobody sweeps.
const scratch = [];
process.on('exit', () => {
  for (const dir of scratch) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});


/**
 * A session with one entry of every kind the file holds.
 *
 * The kinds are the ones `harness/loop.mjs` appends (task, user, assistant,
 * tool, diff, todo, compaction, note, run_stats) plus one this build does
 * not know — a newer build's entry, which the file keeps and the export has
 * to keep too.
 */
function fullSession(store, root) {
  const session = store.create({ root, title: 'the whole session', model: 'a-model' });
  session.append('task', { text: 'fix the second line' });
  session.append('user', { text: 'please fix the second line' });
  session.append('assistant', { text: 'I read the file and changed the line.', reasoning: 'the second line is the wrong one' });
  session.append('tool', { kind: 'replace', arg: 'notes.md', out: 'ok — 1 line changed', ok: true });
  session.append('diff', { file: 'notes.md', added: 1, removed: 1, decision: 'pending' });
  session.append('todo', { items: [{ text: 'read the file', done: true }, { text: 'update the line', done: false }] });
  session.append('note', { text: 'the run paused on a question (ASK)' });
  session.append('compaction', { summary: 'the notes were half fixed', memory: ['the file is notes.md'] });
  session.append('assistant', { text: 'Done — the second line is fixed.' });
  session.append('run_stats', { stopReason: 'done', steps: 3, turns: 2, spent: 7, model: 'a-model' });
  session.append('mystery', { text: 'an entry type this build does not know' });
  return session;
}

test('an exported session keeps every entry', () => {
  const dir = tmp();
  const root = path.join(dir, 'proj');
  fs.mkdirSync(root, { recursive: true });
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = fullSession(store, root);

  const md = toMarkdown(session, { root });

  // The front matter: what a reader needs before the transcript starts.
  assert.match(md, /^---\n/, 'the export opens with a front-matter block');
  assert.match(md, /\ntitle: "the whole session"/, 'it names the session');
  assert.match(md, /\nid: "[0-9a-f]{12}"/, 'it names the id');
  assert.match(md, /\ncreated: "\d{4}-\d\d-\d\dT/, 'it says when the session started');
  assert.match(md, /\nupdated: "\d{4}-\d\d-\d\dT/, 'it says when it was last touched');
  assert.match(md, /\nmodel: "a-model"/, 'it names the model');
  assert.match(md, /\nroot: /, 'it names the project');
  assert.match(md, /\ncredits: 7\n/, 'it carries the credit cost the session recorded');

  // Every entry of the file, in order.
  for (const text of [
    'fix the second line',                              // the task
    'please fix the second line',                       // the prompt
    'I read the file and changed the line.',             // the prose
    'the second line is the wrong one',                  // the reasoning
    'replace',                                          // the tool call
    'notes.md',                                         // and its argument
    'ok — 1 line changed',                              // and its result
    '+1 −1',                                            // the change
    'pending',                                          // and its decision
    '- [x] read the file',                              // the checklist
    '- [ ] update the line',                            // and what is open
    'the run paused on a question (ASK)',               // the note
    'the notes were half fixed',                        // the compaction
    'the file is notes.md',                             // and the fact it carried
    'Done — the second line is fixed.',                 // the closing summary
    'stopped: done',                                    // the run's ending
    'mystery',                                          // an entry type we do not know
    'an entry type this build does not know',           // and its bytes
  ]) {
    assert.ok(md.includes(text), `the export keeps: ${text}`);
  }

  // The checklist is a checklist, and the closing summary is a summary.
  assert.match(md, /## Result/, 'the last words of the run are headed as the result');
  assert.match(md, /## Plan/, 'the plan has its own heading');

  // The HTML carries the same content — one list of blocks, two renderers.
  const html = toHtml(session, { root });
  for (const text of [
    'please fix the second line',
    'I read the file and changed the line.',
    'ok — 1 line changed',
    'the run paused on a question (ASK)',
    'the notes were half fixed',
    'Done — the second line is fixed.',
    'an entry type this build does not know',
  ]) {
    assert.ok(html.includes(text), `the html keeps: ${text}`);
  }
  assert.match(html, /<h2>Plan<\/h2>/, 'the plan is in the html too');
  assert.match(html, /<h2>Result<\/h2>/, 'and so is the closing summary');
});

test('an exported session escapes what the html would have executed', () => {
  const dir = tmp();
  const root = path.join(dir, 'proj');
  fs.mkdirSync(root, { recursive: true });
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root, title: 'a hostile transcript' });
  session.append('user', { text: '<script>alert("xss")</script>' });
  session.append('tool', { kind: 'read', arg: 'x.html', out: '<img src=x onerror="alert(1)">', ok: true });

  const html = toHtml(session, { root });

  assert.ok(!/<script/i.test(html), 'the page carries no script');
  assert.ok(!/<img/i.test(html), 'and no tag the session brought with it');
  assert.ok(html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'), 'the script is shown as text');
  assert.ok(html.includes('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'), 'and so is the image tag');
  // The page carries only the tags the renderer wrote: a transcript holds
  // the model's own words, and words can carry markup.
  const tags = new Set([...html.matchAll(/<\/?([a-z][a-z0-9]*)/gi)].map((m) => m[1].toLowerCase()));
  const allowed = new Set([
    'html', 'head', 'meta', 'title', 'style', 'body', 'main', 'h1', 'h2', 'dl', 'div', 'dt', 'dd',
    'section', 'pre', 'ul', 'li', 'span', 'details', 'summary', 'blockquote', 'p', 'code',
  ]);
  for (const tag of tags) {
    assert.ok(allowed.has(tag), `the page carries no <${tag}> tag`);
  }
  assert.ok(tags.size > 0, 'and it is a page, not an empty one');
});

test('the session tree groups the sessions by day', () => {
  // Noon on three local days: a moment near midnight would land on the day
  // beside it and the grouping would be a test of the clock, not of the tree.
  const day = (back) => new Date(2026, 9, 21 - back, 12, 0, 0).getTime();
  const sessions = [
    { id: 'aaa', title: 'today', updated: day(0), created: day(0), entries: 3, root: 'C:\\proj' },
    { id: 'bbb', title: 'yesterday', updated: day(1), created: day(1), entries: 2, root: 'C:\\proj' },
    { id: 'ccc', title: 'also today', updated: day(0) - 3600_000, created: day(0), entries: 1, root: 'C:\\proj' },
    { id: 'ddd', title: 'last week', updated: day(5), created: day(5), entries: 9, root: 'C:\\proj' },
  ];

  const out = tree({ root: 'C:\\proj', sessions });

  assert.equal(out.count, 4, 'every session is in the tree');
  assert.equal(out.days.length, 3, 'three days carry them');
  assert.deepEqual(out.days.map((d) => d.day), [
    '2026-10-21', '2026-10-20', '2026-10-16',
  ], 'the days are the reader\'s own, newest first');
  assert.deepEqual(out.days[0].sessions.map((s) => s.id), ['aaa', 'ccc'], 'the newest day holds its sessions, newest first');
  assert.deepEqual(out.days[1].sessions.map((s) => s.id), ['bbb'], 'and each day holds its own');
  assert.equal(out.days[0].sessions[0].entryCount, 3, 'the row carries what the picker shows');
  assert.equal(out.sessions.length, 4, 'the flat list is there too');
});

test('an exported session of a session still being written keeps what is on the disk', () => {
  const dir = tmp();
  const root = path.join(dir, 'proj');
  fs.mkdirSync(root, { recursive: true });
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = store.create({ root, title: 'live' });
  session.append('user', { text: 'first' });
  session.append('assistant', { text: 'second' });

  // A run that is mid-append: the last line is half written, and the header
  // has not caught up with the entries (it is rewritten every 25 appends).
  fs.appendFileSync(session.file, '{"type":"assistant","id":"x","paren');
  const live = store.load(session.id, { root });
  assert.ok(live, 'the session still opens');
  assert.equal(live.entries.length, 2, 'the torn line is skipped, the rest is kept');

  const md = toMarkdown(live, { root });
  assert.ok(md.includes('first') && md.includes('second'), 'the export carries what was written');
  // The header counts entries on its own schedule (it is rewritten every 25
  // appends), so the export does not quote a count it cannot see.
  assert.ok(!md.includes('entryCount'), 'the export quotes no count of its own');
});

test('the export methods of the backend answer with the session and the tree', async () => {
  const dir = tmp();
  const root = path.join(dir, 'proj');
  fs.mkdirSync(root, { recursive: true });
  const store = new SessionStore(path.join(dir, 'sessions'));
  const session = fullSession(store, root);

  const harness = { store, root, session };
  const methods = createSessionMethods({
    plugins: { toolTable: () => ({}) },
    harnesses: new Map(),
    runSessions: new Map(),
    staged: new Map(),
    targetFor: () => harness,
    applySettingsTo: () => {},
    partsFor: async () => [],
    dropIndex: () => {},
    emit: () => {},
    root,
    model: null,
  });

  const text = await methods['session.export']({ id: session.id, format: 'md' });
  assert.equal(text.format, 'md');
  assert.ok(text.text.includes('please fix the second line'), 'the export carries the prompt');
  assert.equal(text.path, undefined, 'without a path nothing is written');

  const target = path.join(dir, 'out.html');
  const written = await methods['session.export']({ id: session.id, format: 'html', path: target });
  assert.equal(written.path, target, 'the path comes back');
  assert.ok(fs.readFileSync(target, 'utf8').startsWith('<!doctype html>'), 'and the file is the page');

  // A relative path is relative to the project, the way every other path in
  // the window is.
  const relative = await methods['session.export']({ id: session.id, format: 'md', path: 'export.md' });
  assert.equal(relative.path, path.join(root, 'export.md'), 'the relative path lands in the project');
  assert.ok(fs.existsSync(path.join(root, 'export.md')), 'and the file is there');

  const grouped = await methods['session.tree']({});
  assert.equal(grouped.count, 1, 'the tree holds the project\'s sessions');
  assert.equal(grouped.days.length, 1, 'in one day');

  await assert.rejects(() => methods['session.export']({ id: session.id, format: 'pdf' }), /unknown export format/);
  await assert.rejects(() => methods['session.export']({ id: 'nope', format: 'md' }), /session not found/);
});
