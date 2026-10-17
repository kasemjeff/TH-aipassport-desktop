// Every case must equal path.join.
import path from 'node:path';
import { fileIn } from './app.mjs';
const cases = [['src', 'a.txt'], ['src/', 'a.txt'], ['.', 'a.txt']];
const ok = cases.every(([d, n]) => fileIn(d, n) === path.join(d, n));
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(cases.map(([d, n]) => fileIn(d, n))));
process.exit(ok ? 0 : 1);
