// เรียงตามตัวอักษรแรกของคำไทย
import fs from 'node:fs';
const order = fs.readFileSync('order.txt', 'utf8').replace(/ /g, '').split('');
const words = fs.readFileSync('words.txt', 'utf8').trim().split('\n');
const key = (w) => order.indexOf(w[0]);
const got = [...words].sort((a, b) => key(a) - key(b));
const ok = JSON.stringify(words) === JSON.stringify(got) && words.length === 3;
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(words));
process.exit(ok ? 0 : 1);
