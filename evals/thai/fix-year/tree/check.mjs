// ตรวจว่า README.txt อัปเดตปีเป็น 2569 และไม่แตะบรรทัดอื่น
import fs from 'node:fs';
const lines = fs.readFileSync('README.txt', 'utf8').split('\n');
const ok = lines[0] === 'คู่มือการใช้งาน' && lines[1] === 'อัปเดตล่าสุด: 2569' && lines[2] === 'เวอร์ชัน 1.2';
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(lines.slice(0, 3)));
process.exit(ok ? 0 : 1);
