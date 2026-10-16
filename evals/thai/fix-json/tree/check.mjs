// JSON ต้อง parse ได้และค่าคงเดิม
import fs from 'node:fs';
let got;
try { got = JSON.parse(fs.readFileSync('data.json', 'utf8')); } catch (err) { console.log('FAIL: bad JSON: ' + err.message); process.exit(1); }
const ok = got.ชื่อ === 'สมชาย' && got.อายุ === 35;
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
