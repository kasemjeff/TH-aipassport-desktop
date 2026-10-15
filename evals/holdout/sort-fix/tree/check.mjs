// The project's own check: names come back in alphabetical order.
import { sortNames } from './names.mjs';

const got = sortNames(['ada', 'grace', 'linus']);
const want = ['ada', 'grace', 'linus'];
if (JSON.stringify(got) !== JSON.stringify(want)) {
  console.log(`FAIL: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  process.exit(1);
}
console.log('PASS');
