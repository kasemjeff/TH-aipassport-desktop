// ไฟล์ถูกเปลี่ยนชื่อ และ index ชี้ชื่อใหม่
import fs from 'node:fs';
const ok = fs.existsSync('บันทึกใหม่.md') && !fs.existsSync('บันทึกเก่า.md')
  && fs.readFileSync('index.md', 'utf8').includes('บันทึกใหม่.md')
  && !fs.readFileSync('index.md', 'utf8').includes('บันทึกเก่า.md');
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
