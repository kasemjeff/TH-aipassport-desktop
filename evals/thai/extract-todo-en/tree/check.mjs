// Both TODO items, in order, one per line.
import fs from 'node:fs';
const got = fs.readFileSync('todo.txt', 'utf8').trim().split('\n');
const ok = JSON.stringify(got) === JSON.stringify(['buy coffee', 'send the summary email']);
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
