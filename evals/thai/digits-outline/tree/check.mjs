// ตรวจว่าเลขไทยถูกแปลงเป็นอารบิกครบ
import fs from 'node:fs';
const want = '1. บทนำ\n2. วิธีใช้งาน\n3. ปัญหาที่พบบ่อย\n';
const got = fs.readFileSync('outline.txt', 'utf8');
const ok = got === want;
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
