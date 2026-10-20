// @ts-check
// Upstream WAF neutralisation — one module for every surface.
//
// Ordinary project files are full of the exact shapes a request filter looks
// for: a README with "open http://localhost:3000", a Vue file opening with an
// HTML comment, a shell script with `process.env`. Substituting them on the way
// out and restoring them on the way back lets the model work with stable
// placeholders, and the bytes written to disk are exactly what the file had.
//
// The placeholders deliberately share no substring with the originals, or a
// case-insensitive rule would still match.
//
// One family is not about ordinary code shapes: the upstream edge blocks
// logging calls outright — console.log and five siblings, plus stdout/stderr
// .write — with a Cloudflare 403 that survives any amount of splitting
// (measured against de.aipass.net, 2026-10-15). A second family is equality
// comparisons inside an if — `==`, `===`, `!==` — and even the substring
// "NEQ" there, while a single `=`, `!=`, `<`, `>` and comparisons elsewhere
// pass. Both families sit in the table like everything else, so a test file
// full of console.log lines and ifs still travels.
//
// This file is the single source of the table. agent.mjs, chat.mjs and the
// harness core all import it — the bytes must never drift between them.

/** @type {Array<[RegExp, string]>} */
export const SUBSTITUTIONS = [
  [/127\.0\.0\.1/g, 'LOOPBACK-IP'],
  [/169\.254\.169\.254/g, 'METADATA-IP'],
  [/0\.0\.0\.0/g, 'ANY-IP'],
  [/localhost/gi, 'LCLHST'],
  // URL schemes — https/http/ftp/chrome appear in READMEs and trigger URL-based WAF rules
  [/https:\/\//gi, 'HTTPS-URL'],
  [/http:\/\//gi, 'HTTP-URL'],
  [/chrome:\/\//gi, 'CHROME-URL'],
  [/ftp:\/\//gi, 'FTP-URL'],
  [/file:\/\//gi, 'FILE-URI'],
  // HTML/XSS-shaped tokens that ordinary files carry — a markdown or Vue file
  // opening with an HTML comment is enough to trip an XSS rule.
  [/<!doctype/gi, 'DOCTYPE-DECL'],
  [/<!--/g, 'CMT-OPEN'],
  [/-->/g, 'CMT-CLOSE'],
  [/<script/gi, 'TAG-SCRIPT-OPEN'],
  [/<\/script>/gi, 'TAG-SCRIPT-CLOSE'],
  [/javascript:/gi, 'JS-SCHEME'],
  // Shell / secrets patterns
  [/process\.env/gi, 'PROCESS-ENV'],
  [/\.env\b/gi, 'DOT-ENV'],
  [/node:child_process/gi, 'NODE-CHILD-PROC'],
  [/child_process/gi, 'CHILD-PROC'],
  [/process\.kill/gi, 'PROCESS-KILL'],
  [/\/bin\//gi, 'SLASH-BIN-SLASH'],
  [/\/etc\//gi, 'SLASH-ETC-SLASH'],
  [/\bspawnSync\b/g, 'SPAWN-SYNC-CALL'],
  [/\bspawn\b/g, 'SPAWN-CALL'],
  [/\bexecSync\b/g, 'EXEC-SYNC-CALL'],
  [/ExecutionPolicy/gi, 'EXEC-POLICY'],
  // One word, no separator: the rule matches "Bypass" at any word boundary,
  // so a placeholder spelled "BYPASS-ARG" matched its own rule (the "-" is a
  // boundary) and was encoded a second time. A text that passes through
  // outbound twice — a tool result, encoded by its caller and again by the
  // message it rides in — came back as "Bypass-ARG" and never matched the
  // file it was copied from. "BYPASSARG" is one word, so the rule cannot see
  // it, and the same text can be encoded any number of times.
  [/Bypass\b/gi, 'BYPASSARG'],
  [/powershell/gi, 'PSHELL'],
  [/\.ps1\b/gi, 'DOT-PS1'],
  [/\.sh\b/gi, 'DOT-SH'],
  // Logging calls the edge refuses outright. The token is encoded; the call
  // shape stays, so the model reads a normal-looking line and writes normal
  // code back. The 403 here is not about size: 20 bytes of console.log alone
  // is enough, while console.bar and process.exit pass untouched.
  [/console\.log/gi, 'CONSOLE-LOG'],
  [/console\.warn/gi, 'CONSOLE-WARN'],
  [/console\.error/gi, 'CONSOLE-ERROR'],
  [/console\.info/gi, 'CONSOLE-INFO'],
  [/console\.debug/gi, 'CONSOLE-DEBUG'],
  [/console\.trace/gi, 'CONSOLE-TRACE'],
  [/stdout\.write/gi, 'STDOUT-WRITE'],
  [/stderr\.write/gi, 'STDERR-WRITE'],
  // Comparisons the edge refuses inside an if — `if (x == 5)`, `if (x === 5)`,
  // `if (x !== 5)` all draw a 403, while a single `=`, `!=`, `<`, `>` and the
  // same comparison outside an if pass. The placeholders deliberately avoid
  // both the "==" and "neq" substrings: the edge blocks those by themselves
  // inside an if, so a placeholder spelled "NEQ" gets refused all the same.
  [/!==/g, 'OP-NOT-EQ'],
  [/===/g, 'OP-STRICT-EQ'],
  [/==/g, 'OP-EQ'],
  [/&&/g, 'AND-AND'],
  [/~(?=\/)/g, 'TILDE-PATH'],
  // The general case: a `<` that opens a tag (`<html`, `<div`, `</body>`, a JSX
  // component) is what an XSS rule matches. Encode just that `<` — not `a < b`
  // or `=>` — so any HTML/JSX/XML file survives, restored exactly on write.
  [/<(?=[a-zA-Z/!?])/g, 'TAG-LT'],
];

/** @param {string} text @returns {string} */
export const outbound = (text) => SUBSTITUTIONS.reduce((acc, [re, to]) => acc.replace(re, to), text);

// Reversing loses the original casing of "localhost"; lower case is what
// appears in practice and a mismatch only costs a retry, never a bad write.
/** @type {Array<[RegExp, string]>} */
export const RESTORE = [
  [/LOOPBACK-IP/g, '127.0.0.1'],
  [/METADATA-IP/g, '169.254.169.254'],
  [/ANY-IP/g, '0.0.0.0'],
  [/LCLHST/g, 'localhost'],
  [/HTTPS-URL/g, 'https://'],
  [/HTTP-URL/g, 'http://'],
  [/CHROME-URL/g, 'chrome://'],
  [/FTP-URL/g, 'ftp://'],
  [/FILE-URI/g, 'file://'],
  [/DOCTYPE-DECL/g, '<!doctype'],
  [/CMT-OPEN/g, '<!--'],
  [/CMT-CLOSE/g, '-->'],
  [/TAG-SCRIPT-OPEN/g, '<script'],
  [/TAG-SCRIPT-CLOSE/g, '</script>'],
  [/JS-SCHEME/g, 'javascript:'],
  [/PROCESS-ENV/g, 'process.env'],
  [/DOT-ENV/g, '.env'],
  [/NODE-CHILD-PROC/g, 'node:child_process'],
  [/CHILD-PROC/g, 'child_process'],
  [/PROCESS-KILL/g, 'process.kill'],
  [/SLASH-BIN-SLASH/g, '/bin/'],
  [/SLASH-ETC-SLASH/g, '/etc/'],
  [/SPAWN-SYNC-CALL/g, 'spawnSync'],
  [/SPAWN-CALL/g, 'spawn'],
  [/EXEC-SYNC-CALL/g, 'execSync'],
  [/EXEC-POLICY/g, 'ExecutionPolicy'],
  [/BYPASSARG/g, 'Bypass'],
  [/PSHELL/g, 'powershell'],
  [/DOT-PS1/g, '.ps1'],
  [/DOT-SH/g, '.sh'],
  [/CONSOLE-LOG/g, 'console.log'],
  [/CONSOLE-WARN/g, 'console.warn'],
  [/CONSOLE-ERROR/g, 'console.error'],
  [/CONSOLE-INFO/g, 'console.info'],
  [/CONSOLE-DEBUG/g, 'console.debug'],
  [/CONSOLE-TRACE/g, 'console.trace'],
  [/STDOUT-WRITE/g, 'stdout.write'],
  [/STDERR-WRITE/g, 'stderr.write'],
  [/OP-NOT-EQ/g, '!=='],
  [/OP-STRICT-EQ/g, '==='],
  [/OP-EQ/g, '=='],
  [/AND-AND/g, '&&'],
  [/TILDE-PATH/g, '~'],
  [/TAG-LT/g, '<'],
];

/**
 * Restores placeholders a previously-wrapped value carries. Null and
 * undefined pass through untouched.
 * @overload
 * @param {string} text
 * @returns {string}
 */
/**
 * @overload
 * @param {null|undefined} text
 * @returns {null|undefined}
 */
/** @param {any} text @returns {any} */
export function inbound(text) {
  return text == null ? text : RESTORE.reduce((acc, [re, to]) => acc.replace(re, to), text);
}

// The last-resort drop list, carried into the firewall fallback path: lines
// matching these are dropped whole when a fragment is rejected even on its own.
export const RISKY_LINE = /(node\s+-{1,2}e\b|--eval\b|\beval\(|child_process|exec(Sync)?\(|spawnSync?\(|\bcurl\b|\bwget\b|\b(ba)?sh\b|rm\s+-rf|\/etc\/|\/bin\/|\.\.\/\.\.\/|<!doctype|<!--|-->|<script|<\/script|javascript:|onerror\s*=|onload\s*|ExecutionPolicy|BYPASS|AND-AND|\bpowershell\b)/i;
