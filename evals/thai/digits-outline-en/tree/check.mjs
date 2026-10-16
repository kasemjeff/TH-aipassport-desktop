// The Roman numerals must all become Arabics.
import fs from 'node:fs';
const want = '1. Introduction\n2. Usage\n3. FAQ\n';
const got = fs.readFileSync('outline.txt', 'utf8');
const ok = got === want;
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
