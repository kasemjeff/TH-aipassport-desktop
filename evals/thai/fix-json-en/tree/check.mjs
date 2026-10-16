// Must parse, values intact.
import fs from 'node:fs';
let got;
try { got = JSON.parse(fs.readFileSync('data.json', 'utf8')); } catch (err) { console.log('FAIL: bad JSON: ' + err.message); process.exit(1); }
const ok = got.name === 'Sam' && got.age === 35;
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(got));
process.exit(ok ? 0 : 1);
