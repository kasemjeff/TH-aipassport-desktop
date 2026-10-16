// filled.txt แทนค่าครบทุกช่อง
import fs from 'node:fs';
const want = 'เรียน คุณวิชัย\nเรื่อง การอบรม\nจำนวน 3 ท่าน\n';
const got = fs.readFileSync('filled.txt', 'utf8');
const ok = got === want;
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
