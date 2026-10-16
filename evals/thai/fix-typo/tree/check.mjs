// ทุกคำผิดถูกแทนครบ
import fs from 'node:fs';
const got = fs.readFileSync('text.txt', 'utf8');
const ok = got === 'สวัสดีครับ ผมอยู่ที่นี่\nขอบคุณครับ\n';
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
