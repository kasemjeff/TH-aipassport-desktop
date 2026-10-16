// Bullets became numbers, text untouched.
import fs from 'node:fs';
const want = '1. buy supplies\n2. team meeting\n3. submit work\n';
const got = fs.readFileSync('checklist.txt', 'utf8');
const ok = got === want;
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
