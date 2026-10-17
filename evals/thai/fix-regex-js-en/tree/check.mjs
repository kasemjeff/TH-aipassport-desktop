// The whole string must be hexadecimal.
import { isHex } from './app.mjs';
const ok = isHex('1a2b') === true && isHex('ZZZ1') === false && isHex('1a2b!') === false && isHex('') === false;
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify([isHex('1a2b'), isHex('ZZZ1'), isHex('1a2b!'), isHex('')]));
process.exit(ok ? 0 : 1);
