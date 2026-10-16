// Three unique lines remain, in first-seen order.
import fs from 'node:fs';
const want = 'buy milk\nbuy eggs\npay bill\n';
const got = fs.readFileSync('notes.txt', 'utf8');
const ok = got === want;
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
