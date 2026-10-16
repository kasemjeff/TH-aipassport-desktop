// part.txt must be exactly lines 260-270 of log.txt.
import fs from 'node:fs';
const all = fs.readFileSync('log.txt', 'utf8').split('\n');
const want = all.slice(259, 270).join('\n') + '\n';
const got = fs.readFileSync('part.txt', 'utf8');
const ok = got === want;
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got.slice(0, 60)));
process.exit(ok ? 0 : 1);
