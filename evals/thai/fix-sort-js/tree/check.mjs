// เรียงแบบตัวเลข และ array เดิมต้องไม่ถูกแก้
import { sortNums } from './app.mjs';
const src = [10, 2, 1, 20];
const out = sortNums(src);
const ok = JSON.stringify(out) === JSON.stringify([1, 2, 10, 20]) && JSON.stringify(src) === JSON.stringify([10, 2, 1, 20]);
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify([out, src]));
process.exit(ok ? 0 : 1);
