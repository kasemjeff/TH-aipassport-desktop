// บรรทัดละ 20 อักขระ ต่อกลับได้ข้อความเดิม 
import fs from 'node:fs';
const src = fs.readFileSync('para.txt', 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
const out = fs.readFileSync('wrapped.txt', 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
const lines = out.split('\n');
const ok = lines.join('') === src
  && lines.length > 1
  && lines.slice(0, -1).every((l) => l.length === 20)
  && lines.at(-1).length > 0 && lines.at(-1).length <= 20;
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(lines.map((l) => l.length)));
process.exit(ok ? 0 : 1);
