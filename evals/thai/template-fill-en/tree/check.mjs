// filled.txt must substitute every placeholder.
import fs from 'node:fs';
const want = 'Dear Mr. Vichai\nSubject: training\nGuests: 3\n';
const got = fs.readFileSync('filled.txt', 'utf8');
const ok = got === want;
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
