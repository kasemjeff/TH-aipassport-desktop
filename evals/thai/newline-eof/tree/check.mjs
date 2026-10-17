// ปิดท้ายด้วย \n พอดี 1 ตัว
import fs from 'node:fs';
const raw = fs.readFileSync('log.txt', 'utf8').replace(/\r\n/g, '\n');
const lines = raw.split('\n');
const ok = raw.endsWith('\n') && lines.length === 4 && lines[0] === 'บรรทัดหนึ่ง' && lines[2] === 'บรรทัดสาม' && lines[3] === '';
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(lines));
process.exit(ok ? 0 : 1);
