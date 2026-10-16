// ทุกไฟล์เป็น 2.1.0 ไม่เหลือ 2.0.0
import fs from 'node:fs';
const files = ['package.txt', 'README.txt', 'CHANGELOG.txt'];
const ok = files.every((f) => {
  const s = fs.readFileSync(f, 'utf8');
  return s.includes('2.1.0') && !s.includes('2.0.0');
});
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
