// เหลือสามบรรทัดไม่ซ้ำ
import fs from 'node:fs';
const want = 'ซื้อนม\nซื้อไข่\nจ่ายบิล\n';
const got = fs.readFileSync('notes.txt', 'utf8');
const ok = got === want;
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
