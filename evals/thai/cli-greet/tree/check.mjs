// รับชื่อจาก argument แรกของคำสั่ง
import { spawnSync } from 'node:child_process';
const run = (args) => spawnSync(process.execPath, ['greet.mjs', ...args], { encoding: 'utf8' });
const strip = (s) => String(s ?? '').replace(/\r\n/g, '\n').trim();
const withName = run(['สมชาย']);
const bare = run([]);
const ok = strip(withName.stdout) === 'สวัสดี สมชาย' && strip(bare.stdout) === 'สวัสดี';
console.log(ok ? 'PASS' : 'FAIL: ' + JSON.stringify([strip(withName.stdout), strip(bare.stdout)]));
process.exit(ok ? 0 : 1);
