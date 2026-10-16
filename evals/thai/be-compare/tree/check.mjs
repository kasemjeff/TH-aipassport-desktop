// ต้องตอบงานเลี้ยงปีใหม่
import fs from 'node:fs';
const got = fs.readFileSync('answer.txt', 'utf8').trim();
const ok = got === 'เลี้ยงปีใหม่';
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
