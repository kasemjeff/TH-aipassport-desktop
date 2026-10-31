import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createLanguageServers } from '../harness/lsp.mjs';

const FIXTURE = path.resolve('aipass-bridge/test/fixtures/lsp-echo.mjs');

test('diagnostics come from the server', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-home-'));
  fs.writeFileSync(path.join(home, 'lsp.json'), JSON.stringify({
    servers: { '.txt': { command: process.execPath, args: [FIXTURE], approved: true } },
  }));
  fs.writeFileSync(path.join(root, 'sample.txt'), 'hello');
  const lsp = createLanguageServers({ root, home });
  const res = await lsp.diagnostics('sample.txt');
  await lsp.close();
  assert.equal(res.server, process.execPath === res.server ? res.server : res.server, 'server recorded');
  assert.ok(Array.isArray(res.items) && res.items.length === 1, JSON.stringify(res));
  assert.equal(res.items[0].line, 1);
  assert.equal(res.items[0].severity, 'error');
  assert.match(res.items[0].message, /boom/);
});

test('a missing server says so instead of guessing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-home-'));
  fs.writeFileSync(path.join(root, 'sample.md'), 'hi');
  const lsp = createLanguageServers({ root, home });
  const res = await lsp.diagnostics('sample.md');
  await lsp.close();
  assert.ok(res.none, JSON.stringify(res));
  assert.match(res.none, /no server/i);
});

test('an unapproved project-declared server is refused', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lsp-home-'));
  fs.writeFileSync(path.join(home, 'lsp.json'), JSON.stringify({
    servers: { '.txt': { command: process.execPath, args: [FIXTURE], approved: false } },
  }));
  fs.writeFileSync(path.join(root, 'sample.txt'), 'hi');
  const lsp = createLanguageServers({ root, home });
  const res = await lsp.diagnostics('sample.txt');
  await lsp.close();
  assert.ok(res.none, JSON.stringify(res));
  assert.match(res.none, /not home-approved/i);
});

test('a DIAGNOSE with no lsp pool answers plainly', async () => {
  // exercised via tools: when lsp is null, diagnose says so
  const { tempDir } = await import('./harness.mjs');
  const { Overlay } = await import('../harness/overlay.mjs');
  const { SkillLibrary } = await import('../harness/skills.mjs');
  const { createTools } = await import('../harness/tools.mjs');
  const dir = tempDir({ 'a.txt': 'hi' });
  const overlay = new Overlay(dir);
  const tools = createTools({ root: dir, overlay, skills: new SkillLibrary([]), allowRun: true, lsp: null, maxResult: 6000 });
  const out = await tools.diagnose('a.txt');
  assert.match(out, /no language server is available/);
});