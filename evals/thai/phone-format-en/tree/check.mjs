// Phones digits-only, names intact.
import fs from 'node:fs';
const got = fs.readFileSync('contacts.csv', 'utf8').trim().split('\n');
const ok = got[0] === 'Sam,5551234567' && got[1] === 'Ada,5559876543';
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
