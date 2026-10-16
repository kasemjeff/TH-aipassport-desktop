// ผลต้องเป็น 38.1 ซม.
import fs from 'node:fs';
const got = fs.readFileSync('out.txt', 'utf8').trim();
const ok = Math.abs(parseFloat(got) - 38.1) < 0.02;
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
