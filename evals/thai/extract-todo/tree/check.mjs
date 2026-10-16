// รายการ TODO ครบสองบรรทัด
import fs from 'node:fs';
const got = fs.readFileSync('todo.txt', 'utf8').trim().split('\n');
const ok = JSON.stringify(got) === JSON.stringify(['ซื้อกาแฟ', 'ส่งอีเมลสรุป']);
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
