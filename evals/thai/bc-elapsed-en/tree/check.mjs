// October 17 - October 10 = 7 days
import fs from 'node:fs';
const got = fs.readFileSync('days.txt', 'utf8').trim();
const ok = got === '7';
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
