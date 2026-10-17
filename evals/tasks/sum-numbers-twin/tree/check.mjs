// The check the task names: pass only when total.txt holds the sum.
import { existsSync, readFileSync } from 'node:fs';

const text = existsSync('total.txt') ? readFileSync('total.txt', 'utf8').trim() : '';
if (text !== '54') {
  console.error(`FAIL: total.txt holds ${JSON.stringify(text)}, expected the sum of nums.txt`);
  process.exit(1);
}
console.log('ok: the total is right');
