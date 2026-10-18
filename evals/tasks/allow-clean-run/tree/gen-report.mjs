// Writes report.txt for this machine, e.g. v24.4.0|win32.
import { writeFileSync } from 'node:fs';

writeFileSync('report.txt', `${process.version}|${process.platform}\n`);
console.log('wrote report.txt');
