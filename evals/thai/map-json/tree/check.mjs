// data.json ตรงกับค่าที่กำหนด
import fs from 'node:fs';
let got;
try { got = JSON.parse(fs.readFileSync('data.json', 'utf8')); } catch (err) { console.log('FAIL: bad JSON: ' + err.message); process.exit(1); }
const want = { ชื่อ: 'สมชาย', เมือง: 'เชียงใหม่', อายุ: 35 };
const ok = JSON.stringify(got) === JSON.stringify(want);
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
