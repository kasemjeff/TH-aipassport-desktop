// Header added, rows intact.
import fs from 'node:fs';
const lines = fs.readFileSync('table.csv', 'utf8').split('\n');
const ok = lines[0] === 'name,age' && lines[1] === 'Sam,35' && lines[2] === 'Ada,28';
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(lines.slice(0, 3)));
process.exit(ok ? 0 : 1);
