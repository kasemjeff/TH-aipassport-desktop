// Input must be trimmed before comparing.
import { checkAnswer } from './app.mjs';
const ok = checkAnswer(' correct ') === 'ok' && checkAnswer('wrong answer') === 'wrong';
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
