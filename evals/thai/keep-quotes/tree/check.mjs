// ปีต้องใหม่ แต่ข้อความคำสัญญาต้องเหมือนเดิมเป๊ะ
import fs from 'node:fs';
const lines = fs.readFileSync('announce.txt', 'utf8').replace(/\r\n/g, '\n').split('\n');
const ok = lines[0] === 'ประกาศอัปเดตระบบ ปี 2569' && lines[1] === '' && lines[2] === '"ข้อมูลของคุณจะไม่ถูกส่งออกจากเครื่องนี้" — ทีมงาน';
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(lines.slice(0, 3)));
process.exit(ok ? 0 : 1);
