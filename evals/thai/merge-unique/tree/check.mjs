// merged.txt ต้องไม่มีรายการซ้ำและคงลำดับ
import fs from 'node:fs';
const want = 'มะม่วง\nกล้วย\nฝรั่ง\n';
const got = fs.readFileSync('merged.txt', 'utf8');
const ok = got === want;
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
