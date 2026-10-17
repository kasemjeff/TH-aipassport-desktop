// One h1, the rest h2.
import fs from 'node:fs';
const lines = fs.readFileSync('notes.md', 'utf8').replace(/\r\n/g, '\n').split('\n');
const ok = lines[0] === '# Guide'
  && lines[2] === '## Getting started'
  && lines[4] === 'Click start to open the app'
  && lines[6] === '## Settings';
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(lines.slice(0, 8)));
process.exit(ok ? 0 : 1);
