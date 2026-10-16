// The project's own check. It exits 0 only when total() adds.
import { total } from './math.mjs';

const got = total([1, 2, 3]);
if (got !== 6) {
  console.log(`FAIL: total([1, 2, 3]) returned ${got}, expected 6`);
  process.exit(1);
}
console.log('PASS');
