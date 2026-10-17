// escape &, <, > และ " ให้เป็น entity ของ HTML
import fs from 'node:fs';
const raw = fs.readFileSync('line.txt', 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
const esc = (s) => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');
const want = esc(raw);
const got = fs.readFileSync('escaped.txt', 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '');
const ok = got === want;
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
