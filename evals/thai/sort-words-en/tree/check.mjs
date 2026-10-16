// Lines must be in alphabetical order.
import fs from 'node:fs';
const words = fs.readFileSync('words.txt', 'utf8').trim().split('\n');
const got = [...words].sort();
const ok = JSON.stringify(words) === JSON.stringify(got) && words.length === 3;
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(words));
process.exit(ok ? 0 : 1);
