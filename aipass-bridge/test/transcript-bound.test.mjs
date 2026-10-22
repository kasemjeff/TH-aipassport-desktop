/**
 * The transcript's scrollback is bounded.
 *
 * The rows on screen are the view; the session file on disk is the record. A
 * long session used to leave every row it ever painted in the DOM, so the page
 * grew without limit and the scroll got slow. The oldest rows go now — and a
 * line says how many went, because a window that silently drops what it
 * showed is a window that lies about what it did.
 *
 * Run: node --test aipass-bridge/test/transcript-bound.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TRANSCRIPT = pathToFileURL(path.join(repo, 'desktop', 'ui', 'transcript.js')).href;

/* ------------------------------------------------------------------ the dom */

/** Enough of an element for the transcript to build its rows. */
class El {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.className = '';
    this._text = '';
    this._html = '';
    this.open = false;
    this.title = '';
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return `${this._text ?? ''}${this.children.map((c) => c.textContent ?? '').join('')}`; }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  insertAdjacentHTML(_pos, html) { this._html = `${this._html ?? ''}${html}`; }
  append(...kids) {
    for (const k of kids) {
      if (k && typeof k === 'object') {
        if (k._parent && k._parent !== this) k._parent.children = k._parent.children.filter((c) => c !== k);
        k._parent = this;
        this.children.push(k);
      } else {
        this._text += String(k);
      }
    }
  }
  insertBefore(node, ref) {
    if (node._parent && node._parent !== this) node._parent.children = node._parent.children.filter((c) => c !== node);
    node._parent = this;
    const at = ref ? this.children.indexOf(ref) : -1;
    if (at < 0) this.children.push(node);
    else this.children.splice(at, 0, node);
  }
  remove() { if (this._parent) this._parent.children = this._parent.children.filter((c) => c !== this); }
  addEventListener() {}
}

/** The transcript, on a log of its own. */
async function bootTranscript() {
  const { createTranscript } = await import(TRANSCRIPT);
  const log = new El('div');
  const state = { pluginTools: [], runCursor: null };
  const ctx = {
    el: (tag, cls, text) => {
      const n = new El(tag);
      if (cls) n.className = cls;
      if (text != null) n.textContent = text;
      return n;
    },
    log,
    state,
    scrollDown: () => {},
    atBottom: () => true,
    rpc: async () => ({}),
  };
  return { t: createTranscript(ctx), log, state };
}

/* -------------------------------------------------------------------- tests */

test('the transcript drops its oldest rows and says how many', async () => {
  const { t, log } = await bootTranscript();
  for (let i = 0; i < 500; i += 1) t.addNote(`note-${i}`);
  assert.ok(log.children.length <= 301, `the log stays bounded (${log.children.length} rows)`);
  const marker = log.children.find((c) => /ตัด/.test(c.textContent ?? ''));
  assert.ok(marker, 'the window says it dropped rows');
  assert.match(marker.textContent, /\d+/, 'and how many it dropped');
});

test('the newest rows are the ones that stay', async () => {
  const { t, log } = await bootTranscript();
  for (let i = 0; i < 500; i += 1) t.addNote(`note-${i}`);
  assert.match(log.textContent, /note-499/, 'the last row is still on screen');
  assert.equal(/note-0\b/.test(log.textContent), false, 'the first row is not');
});

test('the live run keeps its start when the rows before it go', async () => {
  // The fold at the end of a run closes over the rows that began at runCursor.
  // A row that leaves the window before that point carries the start of the
  // run with it — otherwise the fold closes over the wrong rows.
  const { t, log, state } = await bootTranscript();
  for (let i = 0; i < 400; i += 1) t.addNote(`old-${i}`);
  state.runCursor = log.children.length;
  t.addNote('run-start');
  for (let i = 0; i < 200; i += 1) t.addNote(`run-${i}`);
  assert.ok(state.runCursor >= 0, 'the cursor still points at a row that exists');
  assert.ok(state.runCursor < log.children.length, 'and not past the end of the log');
});

test('the first trim of a live run keeps the cursor on the run start', async () => {
  // The trim marker is inserted at the front on the first trim, which moves
  // every row down one. The cursor is an index into the log, so it moves too —
  // otherwise foldRun() starts one row early and folds the marker (and the row
  // before the run) into the run.
  const { t, log, state } = await bootTranscript();
  for (let i = 0; i < 299; i += 1) t.addNote(`old-${i}`);
  state.runCursor = log.children.length;
  t.addNote('run-start');
  t.addNote('run-1');
  assert.equal(log.children[state.runCursor].textContent, 'run-start',
    'the cursor points at the first row of the run, not the row before it');
  assert.match(log.children[0].textContent, /ตัด/, 'the trim marker is at the top');
  assert.notEqual(log.children[state.runCursor - 1].className, 'trimmed',
    'and the cursor is not on the marker');
});
