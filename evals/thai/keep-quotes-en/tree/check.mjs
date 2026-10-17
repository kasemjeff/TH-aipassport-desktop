// New year, same promise, byte for byte.
import fs from 'node:fs';
const lines = fs.readFileSync('announce.txt', 'utf8').replace(/\r\n/g, '\n').split('\n');
const ok = lines[0] === 'System update 2026' && lines[1] === '' && lines[2] === '"Your data never leaves this machine" — the team';
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify(lines.slice(0, 3)));
process.exit(ok ? 0 : 1);
