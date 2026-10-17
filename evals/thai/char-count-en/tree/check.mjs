// Count every non-whitespace character.
import fs from 'node:fs';
const text = fs.readFileSync('note.txt', 'utf8').replace(/\r\n/g, '\n');
const want = String(text.replace(/\s/g, '').length);
const got = fs.readFileSync('count.txt', 'utf8').trim();
const ok = got === want;
console.log(ok ? 'PASS' : 'FAIL: got ' + JSON.stringify(got) + ' want ' + want);
process.exit(ok ? 0 : 1);
