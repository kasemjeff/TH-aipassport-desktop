// หัวตารางถูกเติมและแถวเดิมครบ
import fs from 'node:fs';
const lines = fs.readFileSync('table.csv', 'utf8').split('\n');
const ok = lines[0] === 'ชื่อ,อายุ' && lines[1] === 'สมชาย,35' && lines[2] === 'สมหญิง,28';
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(lines.slice(0, 3)));
process.exit(ok ? 0 : 1);
