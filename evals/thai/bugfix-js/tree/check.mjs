// ต้องตัดช่องว่างหัวท้ายก่อนเทียบ
import { checkAnswer } from './app.mjs';
const ok = checkAnswer(' ถูกต้อง ') === 'ok' && checkAnswer('ผิด') === 'wrong';
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
