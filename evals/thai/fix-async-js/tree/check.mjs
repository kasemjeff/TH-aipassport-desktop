// ต้องได้ 42 จาก double(21)
import { double } from './app.mjs';
const ok = (await double(21)) === 42 && (await double(-3)) === -6;
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify([await double(21), await double(-3)]));
process.exit(ok ? 0 : 1);
