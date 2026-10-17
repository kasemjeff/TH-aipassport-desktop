// Keep only the failure lines.
import fs from 'node:fs';
const lines = fs.readFileSync('app.log', 'utf8').replace(/\r\n/g, '\n').split('\n');
const want = lines.filter((l) => l.includes('ERROR:'));
const got = fs.readFileSync('errors.txt', 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
const ok = JSON.stringify(got) === JSON.stringify(want);
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
