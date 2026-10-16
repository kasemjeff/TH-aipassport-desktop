// ชื่อผู้รับต้องคงเดิมทุกไบต์ และมีบรรทัดปิดท้าย
import fs from 'node:fs';
const lines = fs.readFileSync('letter.txt', 'utf8').split('\n');
const ok = lines[0] === 'เรียน คุณสมหญิง รักเรียนดี' && lines.includes('ด้วยความนับถือ');
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(lines));
process.exit(ok ? 0 : 1);
