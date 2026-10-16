// ต้องนับได้ 6 คำ
import fs from 'node:fs';
const got = fs.readFileSync('count.txt', 'utf8').trim();
const ok = got === '6';
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
