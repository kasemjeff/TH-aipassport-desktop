// Every abbreviation is expanded.
import fs from 'node:fs';
const got = fs.readFileSync('text.txt', 'utf8');
const ok = got === 'fly to New York City then to District of Columbia\n';
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
