// Renamed, and the index points at the new name.
import fs from 'node:fs';
const ok = fs.existsSync('new-notes.md') && !fs.existsSync('old-notes.md')
  && fs.readFileSync('index.md', 'utf8').includes('new-notes.md')
  && !fs.readFileSync('index.md', 'utf8').includes('old-notes.md');
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
