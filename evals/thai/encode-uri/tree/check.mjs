// query ต้อง encode แบบ encodeURIComponent
import fs from 'node:fs';
const q = fs.readFileSync('search.txt', 'utf8').replace(/\r\n/g, '\n').trim();
const want = 'https://example.com/search?q=' + encodeURIComponent(q);
const got = fs.readFileSync('url.txt', 'utf8').replace(/\r\n/g, '\n').trim();
const ok = got === want;
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
