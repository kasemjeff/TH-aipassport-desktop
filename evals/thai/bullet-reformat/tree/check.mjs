// บรรทัดถูกเปลี่ยนเป็นเลขลำดับครบ
import fs from 'node:fs';
const want = '1. ซื้อของ\n2. ประชุมทีม\n3. ส่งงาน\n';
const got = fs.readFileSync('รายการ.txt', 'utf8');
const ok = got === want;
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
