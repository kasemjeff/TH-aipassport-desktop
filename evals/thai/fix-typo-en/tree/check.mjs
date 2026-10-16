// Every rule must be applied.
import fs from 'node:fs';
const got = fs.readFileSync('text.txt', 'utf8');
const ok = got === 'please receive the parcel\nwe will separate them\n';
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
