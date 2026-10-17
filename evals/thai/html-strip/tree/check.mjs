// ลบแท็กทั้งหมด เหลือแต่ข้อความ
import fs from 'node:fs';
const raw = fs.readFileSync('page.html', 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
const want = raw.replace(/<[^>]*>/g, '');
const got = fs.readFileSync('plain.txt', 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
const ok = got === want;
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
