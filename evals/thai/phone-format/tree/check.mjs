// เบอร์ถูกแปลงตามกฎ +668...
import fs from 'node:fs';
const got = fs.readFileSync('contacts.csv', 'utf8').trim().split('\n');
const ok = got[0] === 'สมชาย,+66812345678' && got[1] === 'สมหญิง,+6621234567';
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
