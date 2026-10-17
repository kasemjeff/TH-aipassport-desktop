// แปลง INI เป็น JSON โดยค่าทุกตัวเป็น string
import fs from 'node:fs';
const ini = fs.readFileSync('config.ini', 'utf8').replace(/\r\n/g, '\n');
const want = {};
let cur = null;
for (const line of ini.split('\n')) {
  const sec = /^\[(.+)\]$/.exec(line.trim());
  if (sec) { cur = sec[1]; want[cur] = {}; continue; }
  if (!cur || !line.trim()) continue;
  const at = line.indexOf('=');
  want[cur][line.slice(0, at).trim()] = line.slice(at + 1);
}
const got = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const ok = JSON.stringify(got) === JSON.stringify(want);
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
