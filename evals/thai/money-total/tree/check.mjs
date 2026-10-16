// ผลรวมต้องเป็น 245.50
import fs from 'node:fs';
const got = fs.readFileSync('total.txt', 'utf8').trim();
const ok = Math.abs(parseFloat(got) - 245.5) < 0.001;
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
