// Drop the title, keep the name.
import fs from 'node:fs';
const got = fs.readFileSync('given.txt', 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
const want = ['John Smith', 'Jane Doe', 'Ann Lee'];
const ok = JSON.stringify(got) === JSON.stringify(want);
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
