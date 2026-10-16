// The answer must be new-year-party.
import fs from 'node:fs';
const got = fs.readFileSync('answer.txt', 'utf8').trim();
const ok = got === 'new-year-party';
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
