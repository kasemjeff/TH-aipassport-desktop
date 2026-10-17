// ลำดับต้องตรงกับ priority.txt ทุกตัว
import fs from 'node:fs';
const want = fs.readFileSync('priority.txt', 'utf8').replace(/\r\n/g, '\n').trim().split('\n');
const got = JSON.parse(fs.readFileSync('sorted.json', 'utf8'));
const ok = JSON.stringify(got) === JSON.stringify(want);
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
