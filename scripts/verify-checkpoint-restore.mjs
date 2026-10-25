#!/usr/bin/env node
// Live verification script for checkpoints / restore (the undo of an apply).
// Runs an end-to-end apply → restore cycle against a real project directory on disk,
// asserting exact byte-for-byte restoration of modified, added, and complex files
// (including Thai unicode and CRLF line endings).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Overlay } from '../aipass-bridge/harness/overlay.mjs';
import { applyOverlay } from '../aipass-bridge/harness/loop.mjs';
import { list, restore, remove, storeRoot } from '../aipass-bridge/harness/checkpoints.mjs';

const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-live-ckpt-'));
console.log(`[checkpoint-verify] Project root: ${tempProject}`);

try {
  // 1. Setup original files
  const file1 = path.join(tempProject, 'src', 'index.js');
  const file2 = path.join(tempProject, 'docs', 'thai.txt');
  fs.mkdirSync(path.dirname(file1), { recursive: true });
  fs.mkdirSync(path.dirname(file2), { recursive: true });

  const originalContent1 = 'console.log("hello world");\r\n';
  const originalContent2 = Buffer.from('\uFEFFข้อความทดสอบ ภาษาไทย\r\nบรรทัดที่สอง\r\n', 'utf8');

  fs.writeFileSync(file1, originalContent1, 'utf8');
  fs.writeFileSync(file2, originalContent2);

  // 2. Stage changes (edit index.js, edit thai.txt, add new_file.txt)
  const overlay = new Overlay(tempProject);
  overlay.set(file1, 'console.log("modified version");\r\n');
  overlay.set(file2, Buffer.from('เนื้อหาใหม่\n', 'utf8'));
  const newFile = path.join(tempProject, 'new_file.txt');
  overlay.set(newFile, 'newly created file\n');

  // 3. Apply changes
  const applyResult = applyOverlay(overlay);
  assert.ok(applyResult.checkpoint?.id, 'apply left a checkpoint id behind');
  const ckptId = applyResult.checkpoint.id;
  console.log(`[checkpoint-verify] Created checkpoint: ${ckptId}`);

  // Assert applied changes on disk
  assert.equal(fs.readFileSync(file1, 'utf8'), 'console.log("modified version");\r\n');
  assert.ok(fs.existsSync(newFile), 'new file exists after apply');

  // 4. Verify checkpoint is listed
  const listed = list({ root: tempProject });
  assert.ok(listed.some((c) => c.id === ckptId), 'checkpoint is listed');

  // 5. Restore checkpoint
  const restoreResult = restore({ root: tempProject, id: ckptId });
  console.log(`[checkpoint-verify] Restored: ${restoreResult.restored.join(', ')} | Removed: ${restoreResult.removed.join(', ')}`);

  // Assert files are restored byte-for-byte
  assert.equal(fs.readFileSync(file1, 'utf8'), originalContent1, 'index.js was restored byte-for-byte');
  assert.deepEqual(fs.readFileSync(file2), originalContent2, 'thai.txt was restored byte-for-byte');
  assert.ok(!fs.existsSync(newFile), 'new_file.txt was cleanly removed on restore');

  // 6. Clean up checkpoint
  remove({ root: tempProject, id: ckptId });
  const afterRemove = list({ root: tempProject });
  assert.ok(!afterRemove.some((c) => c.id === ckptId), 'checkpoint was removed from store');

  console.log('✓ Checkpoint apply → restore live verification passed successfully!');
} finally {
  fs.rmSync(tempProject, { recursive: true, force: true });
}
