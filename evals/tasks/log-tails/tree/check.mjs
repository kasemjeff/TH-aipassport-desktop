// The project's own check. It exits 0 only when lastlines.json carries the
// exact bytes value of each log's last line.
import fs from 'node:fs';

const EXPECT = {
  '2026-10-23.log': 28181,
  '2026-10-24.log': 35118,
  '2026-10-25.log': 42055,
};

let tally;
try {
  tally = JSON.parse(fs.readFileSync('lastlines.json', 'utf8'));
} catch (err) {
  console.log(`FAIL: lastlines.json is missing or not valid JSON (${err.message})`);
  process.exit(1);
}
const problems = [];
const keys = Object.keys(tally).sort();
const want = Object.keys(EXPECT).sort();
if (keys.join(',') !== want.join(',')) {
  problems.push(`expected keys ${want.join(', ')}, got ${keys.join(', ') || '(none)'}`);
}
for (const [name, value] of Object.entries(EXPECT)) {
  const got = tally[name];
  if (got !== value) problems.push(`${name}: expected ${value}, got ${JSON.stringify(got)}`);
}
if (problems.length) {
  console.log(`FAIL: ${problems.join('; ')}`);
  process.exit(1);
}
console.log('PASS');
