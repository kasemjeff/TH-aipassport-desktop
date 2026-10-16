// README.txt must show 2026 on the updated line and nothing else may change.
import fs from 'node:fs';
const lines = fs.readFileSync('README.txt', 'utf8').split('\n');
const ok = lines[0] === 'User guide' && lines[1] === 'Last updated: 2026' && lines[2] === 'Version 1.2';
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(lines.slice(0, 3)));
process.exit(ok ? 0 : 1);
