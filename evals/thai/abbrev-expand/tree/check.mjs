// คำย่อถูกแทนคำเต็มครบ
import fs from 'node:fs';
const got = fs.readFileSync('text.txt', 'utf8');
const ok = got === 'เดินทางไป กรุงเทพมหานคร แล้วกลับ ประเทศ\n';
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
