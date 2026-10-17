// อ่าน CSV โดยเคารพเครื่องหมายคำพูด
import fs from 'node:fs';
function parseLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}
const rows = fs.readFileSync('rows.csv', 'utf8').replace(/\r\n/g, '\n').trim().split('\n');
const want = rows.map((r) => parseLine(r)[1]);
const got = fs.readFileSync('names.txt', 'utf8').replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
const ok = JSON.stringify(got) === JSON.stringify(want);
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
