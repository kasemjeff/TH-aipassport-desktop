#!/usr/bin/env node
// aipass relocate <old> <new> — re-key one project's stored data after its
// folder moved: a new machine, a new disk, a renamed directory.
//
// The app keys sessions, cross-session memory, path rules and the project list
// by absolute path, so copying ~/.aipass to another machine brings the bytes
// but not the connections. This command is the other half: it rewrites those
// keys to the new path, merging with anything already stored there. The
// project folder itself must already be at its new home — this reconnects the
// bookkeeping, it does not move files.
//
// Refused while the desktop app is running: it holds the old paths and its
// open sessions in memory, and re-keying the files under it would split the
// data between the two spellings.
import { tryDesktopRpc } from './harness/desktop-rpc.mjs';
import { relocateProject } from './harness/relocate.mjs';

const [from, to, ...rest] = process.argv.slice(2);

const usage = () => console.log(`usage: aipass relocate <old-path> <new-path>

  Move a project's stored data onto a new absolute path:
  sessions, cross-session memory, path rules and the project list entry.
  The folder must already be at its new home. Run it once per moved project
  after copying a home folder to another machine.

  example:
    aipass relocate "C:\\Users\\old\\work\\app" "C:\\Users\\new\\work\\app"`);

if (from === '--help' || from === '-h') {
  usage();
  process.exit(0);
}
if (!from || !to || rest.length) {
  usage();
  process.exit(1);
}

const running = await tryDesktopRpc('status').catch(() => null);
if (running) {
  console.error('the desktop app is running — quit it first.');
  console.error('it holds the old paths and its open sessions in memory, and relocating under it would split the data in two.');
  process.exit(1);
}

try {
  const out = relocateProject({ from, to });
  console.log(`relocated ${out.from} → ${out.to}`);
  console.log(`  sessions  ${out.sessions.moved}`);
  console.log(`  memory    ${out.facts} fact${out.facts === 1 ? '' : 's'}`);
  console.log(`  rules     ${out.rules.rules} rule${out.rules.rules === 1 ? '' : 's'}, ${out.rules.grants} grant${out.rules.grants === 1 ? '' : 's'}`);
  console.log(`  project   ${out.settings ? 'entry updated' : 'was not in the list — add it in the window'}`);
} catch (err) {
  console.error(String(err?.message ?? err));
  process.exit(1);
}
