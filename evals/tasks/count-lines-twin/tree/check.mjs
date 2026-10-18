// The check the task names: pass only when lines.txt holds the line count.
import { existsSync, readFileSync } from 'node:fs';

const text = existsSync('lines.txt') ? readFileSync('lines.txt', 'utf8').trim() : '';
if (text !== '9') {
  console.error(`FAIL: lines.txt holds ${JSON.stringify(text)}, expected the number of lines in log.txt`);
  process.exit(1);
}
console.log('ok: the count is right');
