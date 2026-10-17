// ตัดคำนำหน้า เหลือชื่อ-นามสกุล
import fs from 'node:fs';
const got = fs.readFileSync('given.txt', 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
const want = ['สมชาย ใจดี', 'สมหญิง รักเรียน', 'มาลี ศรีสุข'];
const ok = JSON.stringify(got) === JSON.stringify(want);
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
