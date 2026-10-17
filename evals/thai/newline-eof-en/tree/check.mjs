// Exactly one trailing newline.
import fs from 'node:fs';
const raw = fs.readFileSync('log.txt', 'utf8').replace(/\r\n/g, '\n');
const lines = raw.split('\n');
const ok = raw.endsWith('\n') && lines.length === 4 && lines[0] === 'first line' && lines[2] === 'third line' && lines[3] === '';
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(lines));
process.exit(ok ? 0 : 1);
