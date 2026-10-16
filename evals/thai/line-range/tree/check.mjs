// part.txt ต้องเป็นบรรทัด 260-270 ของ log.txt เป๊ะ
import fs from 'node:fs';
const all = fs.readFileSync('log.txt', 'utf8').split('\n');
const want = all.slice(259, 270).join('\n') + '\n';
const got = fs.readFileSync('part.txt', 'utf8');
const ok = got === want;
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got.slice(0, 60)));
process.exit(ok ? 0 : 1);
