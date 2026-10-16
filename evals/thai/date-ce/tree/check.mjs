// due.txt ต้องเป็น 2026-01-15
import fs from 'node:fs';
const got = fs.readFileSync('due.txt', 'utf8').trim();
const ok = got === '2026-01-15';
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
