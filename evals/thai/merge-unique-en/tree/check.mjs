// merged.txt deduped, first-seen order kept.
import fs from 'node:fs';
const want = 'pear\napple\nfig\n';
const got = fs.readFileSync('merged.txt', 'utf8');
const ok = got === want;
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
