#!/usr/bin/env node
// aipass scale — test-time scaling: run a task N times, keep the best by check verdict.
//
//   aipass scale "task" --n 3 [--root .] [--allow-run] [--max 20]
//
// Each attempt is a full run in the same conversation; the overlay is cleared
// on entry, so attempts do not bleed into each other's disk state. The best
// attempt by check verdict (pass > none > fail) is reported at the end.
import fs from 'node:fs';
import path from 'node:path';
import { Harness } from './harness/harness.mjs';
import { SkillLibrary } from './harness/skills.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = argv.indexOf(`--${name}`); return i === -1 ? fallback : argv[i + 1]; };
const has = (name) => argv.includes(`--${name}`);
const task = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--')).join(' ').trim();
if (!task) { console.error('usage: aipass scale "task" [--n 3] [--root .] [--allow-run] [--max N]'); process.exit(1); }
const ROOT = path.resolve(flag('root', process.cwd()));
const BRIDGE = (flag('bridge', 'http://127.0.0.1:8787')).replace(/\/+$/, '');
const MODEL = flag('model', null);
const N = Number(flag('n', 3));
const ALLOW_RUN = has('allow-run');
const MAX_RAW = Number(flag('max', 0));
const MAX_STEPS = Number.isFinite(MAX_RAW) && MAX_RAW > 0 ? Math.floor(MAX_RAW) : 0;

const harness = new Harness({
  root: ROOT,
  bridgeURL: BRIDGE,
  model: MODEL,
  options: {
    maxSteps: MAX_STEPS,
    allowRun: ALLOW_RUN,
    mode: 'auto',
    slim: true,
    subagent: false,
    plan: false,
    searchI: false,
    attach: false,
    webScratch: false,
    parallelHelpers: false,
    maxResult: 3000,
  },
  store: 'off',
});
const { events } = harness;
events.on('note', ({ text }) => console.log(`  ${text}`));
events.on('step', ({ step, maxSteps, elapsed }) => console.log(`  attempt step ${step}${maxSteps > 0 ? '/' + maxSteps : ''} (${elapsed}s)`));

const res = await harness.scale(task, N);
console.log('\n--- results ---');
for (const r of res.results) {
  if (r.error) console.log(`attempt ${r.attempt}: ERROR ${r.error}`);
  else console.log(`attempt ${r.attempt}: ${r.stopReason} (steps ${r.steps}) check=${r.check?.verdict ?? 'none'}`);
}
console.log(`\nbest attempt: ${res.best?.attempt}  check=${res.best?.check?.verdict ?? 'none'}`);
if (res.best?.summary) console.log(`summary: ${res.best.summary}`);
if (res.best?.changes?.length) console.log(`changes: ${res.best.changes.length} file(s)`);
process.exit(0);
