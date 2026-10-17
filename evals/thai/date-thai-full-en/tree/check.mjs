// Must read exactly "17 October 2026".
import fs from 'node:fs';
const got = fs.readFileSync('date-out.txt', 'utf8').replace(/\r\n/g, '\n').trim();
const ok = got === '17 October 2026';
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
