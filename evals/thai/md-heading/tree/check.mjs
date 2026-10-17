// h1 เดียว ที่เหลือ h2
import fs from 'node:fs';
const lines = fs.readFileSync('notes.md', 'utf8').replace(/\r\n/g, '\n').split('\n');
const ok = lines[0] === '# คู่มือใช้งาน'
  && lines[2] === '## เริ่มต้น'
  && lines[4] === 'กดปุ่มเริ่มเพื่อเปิดโปรแกรม'
  && lines[6] === '## ตั้งค่า';
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(lines.slice(0, 8)));
process.exit(ok ? 0 : 1);
