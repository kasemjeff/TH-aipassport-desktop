// title must survive byte-exact.
import fs from 'node:fs';
const got = fs.readFileSync('title.txt', 'utf8').trim();
const ok = got === 'Mass Transit Improvement Plan';
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
