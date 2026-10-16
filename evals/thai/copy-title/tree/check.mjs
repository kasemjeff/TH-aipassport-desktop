// title ต้องตรงทุกไบต์
import fs from 'node:fs';
const got = fs.readFileSync('title.txt', 'utf8').trim();
const ok = got === 'แผนพัฒนาระบบขนส่งมวลชน';
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
