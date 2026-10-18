#!/usr/bin/env node
// aipass memory — inspect or clear the facts carried across sessions for this project.
//
//   aipass memory            list persisted facts
//   aipass memory clear      forget all of them
//   aipass memory path       print the store file
import { loadMemory, clearMemory, memoryPath } from './harness/memory-store.mjs';
import { homedir } from 'node:os';
import path from 'node:path';

const cmd = process.argv[2] || 'list';
const root = process.cwd();

if (cmd === 'clear') {
  clearMemory(root);
  console.log('forgot all cross-session facts for this project');
  process.exit(0);
}
if (cmd === 'path') {
  console.log(memoryPath(root));
  process.exit(0);
}
if (cmd === 'list' || cmd === 'ls') {
  const facts = loadMemory(root);
  if (!facts.length) { console.log('(no cross-session facts yet)'); process.exit(0); }
  console.log(`${facts.length} fact(s) carried across sessions:`);
  for (const f of facts) console.log('  - ' + f);
  process.exit(0);
}
console.log('usage: aipass memory [list|clear|path]');
process.exit(1);
