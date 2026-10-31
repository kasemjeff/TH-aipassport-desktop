import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tempDir } from './harness.mjs';
import { Overlay } from '../harness/overlay.mjs';
import { SkillLibrary } from '../harness/skills.mjs';
import { createTools } from '../harness/tools.mjs';

const toolsAt = (dir, overlay, sandbox) => createTools({
  root: dir, overlay, skills: new SkillLibrary([]), allowRun: true, sandbox, maxResult: 6000,
});

test('a RUN in a mode with no backend refuses instead of running', async () => {
  const dir = tempDir({ 'x.txt': 'hi' });
  const overlay = new Overlay(dir);
  const tools = toolsAt(dir, overlay, 'read-only');
  const out = await tools.run('', 'echo hello');
  assert.match(out, /not available/);
  assert.match(out, /danger-full-access/);
});

test('a RUN with sandbox off runs normally', async () => {
  const dir = tempDir({ 'x.txt': 'hi' });
  const overlay = new Overlay(dir);
  const tools = toolsAt(dir, overlay, 'off');
  const out = await tools.run('', 'echo hello');
  assert.match(out, /hello/);
});

test('VERIFY refuses the same way when the backend is missing', async () => {
  const dir = tempDir({ 'x.txt': 'hi' });
  const overlay = new Overlay(dir);
  const tools = toolsAt(dir, overlay, 'workspace-write');
  const out = await tools.verify('echo hello');
  assert.match(out, /not available/);
});