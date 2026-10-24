#!/usr/bin/env node
// aipass sessions — the conversations this project keeps on disk.
//
//   aipass sessions             list the project's sessions
//   aipass sessions list        the same
//   aipass sessions archived    the ones in the archive
//   aipass sessions archive     move the idle ones into the archive
//   aipass sessions restore ID  take one back out of the archive
//   aipass sessions prune       delete the archived ones that have sat too long
//   aipass sessions path        print the directory they live in
//
// The archive is a place a session can be put AND a place it can be taken
// from: `restore` is the way back, and `prune` is the answer to a project
// that has been keeping every conversation it ever had.
import { SessionStore } from './harness/session.mjs';
import { aipassHome } from './harness/settings.mjs';
import path from 'node:path';

const argv = process.argv.slice(2);
const cmd = argv[0] || 'list';
const root = process.cwd();
const store = new SessionStore(path.join(aipassHome(), 'sessions'));

const flag = (name, fallback) => {
  const at = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (at === -1) return fallback;
  const arg = argv[at];
  if (arg.includes('=')) return arg.slice(arg.indexOf('=') + 1);
  return argv[at + 1] ?? fallback;
};

const when = (ts) => (ts ? new Date(ts).toLocaleString() : '(unknown)');

if (cmd === 'path') {
  console.log(store.dirFor(root));
  process.exit(0);
}

if (cmd === 'list' || cmd === 'ls') {
  const list = store.list(root);
  if (!list.length) { console.log('(no sessions for this project yet)'); process.exit(0); }
  console.log(`${list.length} session(s) for ${root}:`);
  for (const s of list) console.log(`  ${s.id}  ${when(s.updated)}  ${s.title ?? '(untitled)'}`);
  process.exit(0);
}

if (cmd === 'archived') {
  const list = store.listArchived(root);
  if (!list.length) { console.log('(the archive is empty)'); process.exit(0); }
  console.log(`${list.length} archived session(s):`);
  for (const s of list) console.log(`  ${s.id}  ${when(s.updated)}  ${s.title ?? '(untitled)'}`);
  process.exit(0);
}

if (cmd === 'archive') {
  const days = Number(flag('older-than', 30));
  const limit = Number(flag('limit', 50));
  const out = store.archiveIdle(root, {
    olderThanMs: (Number.isFinite(days) ? days : 30) * 24 * 3600 * 1000,
    limit: Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 50)),
  });
  console.log(out.archived.length
    ? `archived ${out.archived.length} session(s) into ${out.archiveDir}`
    : '(nothing idle long enough to archive)');
  process.exit(0);
}

if (cmd === 'restore') {
  const id = argv[1];
  if (!id) { console.log('usage: aipass sessions restore <id>'); process.exit(1); }
  const back = store.restore(id, { root });
  console.log(back ? `restored ${id} into the picker` : `no archived session with that id (${id})`);
  process.exit(back ? 0 : 1);
}

if (cmd === 'prune') {
  const days = Number(flag('older-than', 90));
  const limit = Number(flag('limit', 20));
  const out = store.pruneArchived(root, {
    olderThanMs: (Number.isFinite(days) ? days : 90) * 24 * 3600 * 1000,
    limit: Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 20)),
  });
  console.log(out.count ? `deleted ${out.count} archived session(s)` : '(nothing archived long enough to delete)');
  process.exit(0);
}

console.log('usage: aipass sessions [list|archived|archive|restore|prune|path]');
process.exit(1);
