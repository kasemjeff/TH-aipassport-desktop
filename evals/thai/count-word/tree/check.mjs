// ต้องนับได้ 4 ครั้ง
import fs from 'node:fs';
const got = fs.readFileSync('count.txt', 'utf8').trim();
const all = fs.readFileSync('corpus1.txt', 'utf8') + fs.readFileSync('corpus2.txt', 'utf8');
const n = all.split('ประชาชน').length - 1;
const ok = n === 4 && got === '4';
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
