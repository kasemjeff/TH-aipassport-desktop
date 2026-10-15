// The project's own check: the port must be a usable integer.
import fs from 'node:fs';

const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const ok = Number.isInteger(cfg.port) && cfg.port >= 1 && cfg.port <= 65535;
console.log(ok ? `PASS: port ${cfg.port}` : `FAIL: port must be an integer in 1..65535, got ${JSON.stringify(cfg.port)}`);
process.exit(ok ? 0 : 1);
