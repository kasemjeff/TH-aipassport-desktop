// ต้องได้ [3, 4, 5] และ array สั้นก็ต้องครบ
import { lastThree } from './app.mjs';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ok = same(lastThree([1, 2, 3, 4, 5]), [3, 4, 5]) && same(lastThree([7, 8]), [7, 8]) && same(lastThree([]), []);
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify([lastThree([1, 2, 3, 4, 5]), lastThree([7, 8]), lastThree([])]));
process.exit(ok ? 0 : 1);
