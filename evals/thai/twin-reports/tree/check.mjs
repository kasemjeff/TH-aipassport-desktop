// out.txt ต้องเป็นบรรทัดยอดขายของไฟล์จริง (1200)
import fs from 'node:fs';
const got = fs.readFileSync('out.txt', 'utf8').trim();
const ok = got.includes('1200') && !got.includes('999');
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
