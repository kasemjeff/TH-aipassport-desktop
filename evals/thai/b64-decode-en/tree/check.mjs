// data.txt must decode to the original message (UTF-8).
import fs from 'node:fs';
const b64 = fs.readFileSync('data.txt', 'utf8').replace(/\r\n/g, '\n').trim();
const got = fs.readFileSync('decoded.txt', 'utf8').replace(/\r\n/g, '\n').trim();
const ok = Buffer.from(b64, 'base64').toString('utf8') === 'Good morning' && got === 'Good morning';
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
