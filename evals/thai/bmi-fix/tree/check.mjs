// ปัด 1 ตำแหน่ง และคืน null เมื่อค่าไม่ถูกต้อง
import { bmi } from './app.mjs';
const ok = bmi(70, 1.75) === 22.9 && bmi(60, 1.6) === 23.4 && bmi(50, 0) === null && bmi(0, 1.7) === null;
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify([bmi(70, 1.75), bmi(60, 1.6), bmi(50, 0), bmi(0, 1.7)]));
process.exit(ok ? 0 : 1);
