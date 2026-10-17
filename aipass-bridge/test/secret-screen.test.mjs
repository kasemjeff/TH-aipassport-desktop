// The secret screen on the execution channels.
//
// The file-tool floor (permissions.evaluate) sees tool args — a NEED for
// `.env` is denied before the mode is consulted. But a RUN carries its
// command in `body`, a GIT can name a path inside the repository, and SEARCH
// used to read any file whose name did not start with a dot. These three
// channels share one screen now: the same SECRET_RULES table, applied to the
// words a command spells. What the screen cannot catch (a name built at
// runtime inside a program) is stated in SECURITY.md — allowRun is the gate.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTools } from '../harness/tools.mjs';
import { Overlay } from '../harness/overlay.mjs';
import { secretHit, scrubSecretDiff } from '../harness/permissions.mjs';

const mk = (files) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-secret-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  return dir;
};
const dirs = [];
const mkTracked = (files) => { const dir = mk(files); dirs.push(dir); return dir; };
after(() => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); });

const toolsIn = (dir, extra = {}) => createTools({ root: dir, overlay: new Overlay(dir), ...extra });

test('secretHit catches the spellings a command can carry, and leaves normal words alone', () => {
  assert.ok(secretHit('type .env'), 'the bare dot-file');
  assert.ok(secretHit('cat C:\\proj\\.env'), 'a Windows path');
  assert.ok(secretHit('git show HEAD:.env'), 'a repo path after a colon');
  assert.ok(secretHit('cat id_rsa'), 'a key name without a dot');
  assert.ok(secretHit('copy certs/server.pem out.txt'), 'a certificate');
  assert.ok(secretHit('cat ~/.aws/credentials'), 'a cloud credential path');
  assert.equal(secretHit('npm test'), null);
  assert.equal(secretHit('node scripts/build.mjs --env production'), null, '--env is a flag, not a file');
  assert.equal(secretHit('git log --oneline -5'), null);
});

test('a RUN whose command names a secret file is refused before anything spawns', async () => {
  const tools = toolsIn(mkTracked({}), { allowRun: true });
  const refused = await tools.run('', 'type .env');
  assert.match(refused, /secret files stay on this machine/);
  const control = await tools.run('', 'echo hello');
  assert.match(control, /hello/, 'an ordinary command still runs');
});

test('SEARCH skips secret files that are not dot-hidden, and finds the clean ones', async () => {
  const tools = toolsIn(mkTracked({
    'server.pem': 'KEYMATERIAL',
    'id_rsa': 'PRIVATEKEYMATERIAL',
    'notes.txt': 'the needle is here',
  }));
  assert.match(await tools.search('needle'), /notes\.txt/, 'the clean file is still searchable');
  assert.match(await tools.search('KEYMATERIAL'), /no matches/, 'a .pem is not a result');
  assert.match(await tools.search('PRIVATEKEYMATERIAL'), /no matches/, 'id_rsa is not a result');
});

test('GIT refuses an argument that names a secret file', async () => {
  const tools = toolsIn(mkTracked({}));
  const refused = await tools.git('show HEAD:.env');
  assert.match(refused, /secret files stay on this machine/);
});

test('a git patch touching a secret file is withheld, the clean chunk stays', () => {
  const sample = [
    'commit abc123',
    'Author: someone',
    'diff --git a/app.js b/app.js',
    '--- a/app.js',
    '+++ b/app.js',
    '+const ok = true;',
    'diff --git a/.env b/.env',
    '--- a/.env',
    '+++ b/.env',
    '+SECRET=1',
  ].join('\n');
  const scrubbed = scrubSecretDiff(sample);
  assert.match(scrubbed, /app\.js/, 'the clean diff survives');
  assert.doesNotMatch(scrubbed, /SECRET=1/, 'the secret bytes are gone');
  assert.match(scrubbed, /withheld/);
  assert.equal(scrubSecretDiff('nothing to see'), 'nothing to see');
});
