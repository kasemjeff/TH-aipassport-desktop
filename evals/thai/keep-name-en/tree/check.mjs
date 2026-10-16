// The name must survive byte-exact, with the closing appended.
import fs from 'node:fs';
const lines = fs.readFileSync('letter.txt', 'utf8').split('\n');
const ok = lines[0] === 'Dear Ms. Grace Hopper,' && lines.includes('Sincerely,');
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(lines));
process.exit(ok ? 0 : 1);
