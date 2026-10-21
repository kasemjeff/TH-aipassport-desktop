// The contract between the window and the backend: every RPC method the
// window calls has to exist on the backend.
//
// The window is a plain page with no types, so a method the window calls that
// the backend does not have is a 404 in the window's own log — in front of a
// person who only wanted to use the app. The QA loop has caught this by hand
// before; this module is where the rule lives, so the QA loop and the suite
// ask the same question and get the same answer.
//
// Two lists, both read from the source:
//   - the methods desktop/ui calls, and
//   - the methods the backend's `methods` object defines.
//
// The backend's object is read as a block, not as a whole-file regex: a
// pattern loose enough to catch `if (` catches a lot more than it should.
// The block is the `return { … }` of a domain module under
// `aipass-bridge/harness/rpc/` — one per domain — so the list is read from
// all of them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The RPC methods the window calls, in the order it calls them. */
export function windowMethods(appSource) {
  return [...new Set([...appSource.matchAll(/\brpc\(\s*'([a-zA-Z][\w.]*)'/g)].map((m) => m[1]))];
}

/**
 * The window's own modules: the page and everything it is split into.
 *
 * A method the window calls from a module is a method the window calls — so
 * the contract reads all of `desktop/ui`, not only the entry file.
 */
export function windowSources({ repo = REPO } = {}) {
  const dir = path.join(repo, 'desktop', 'ui');
  const files = [];
  const walk = (where) => {
    for (const entry of fs.readdirSync(where, { withFileTypes: true })) {
      const full = path.join(where, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(dir);
  return files.sort().map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}

/**
 * The RPC methods the backend defines.
 *
 * The object is read as a block: from the `return {` of a domain module to
 * the end of that block. A pattern loose enough to catch `if (` catches a lot
 * more than it should, and a method the backend really has must not be missed
 * because it lives in a file nobody looked at.
 */
export function backendMethods(rpcSource) {
  const start = rpcSource.indexOf('  return {');
  if (start === -1) return [];
  const body = rpcSource.slice(start);
  // The object ends at the first line that closes it at the same indent.
  const end = body.indexOf('\n  };');
  const block = end === -1 ? body : body.slice(0, end);
  return [...new Set([
    // async 'settings.get'(params = {}) { ... }
    ...[...block.matchAll(/^\s*async\s+'([^']+)'\s*\(/gm)].map((m) => m[1]),
    // async status(params = {}) { ... }
    ...[...block.matchAll(/^\s*async\s+([a-zA-Z][\w]*)\s*\(/gm)].map((m) => m[1]),
    // cancel(params = {}) { ... } — the one method that is not async.
    ...[...block.matchAll(/^\s*([a-zA-Z][\w]*)\s*\(/gm)].map((m) => m[1]),
  ])];
}

/** The backend's domain modules, and the methods they define together. */
export function backendMethodList({ repo = REPO } = {}) {
  const dir = path.join(repo, 'aipass-bridge', 'harness', 'rpc');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort()
    : [];
  const defined = [];
  for (const file of files) {
    defined.push(...backendMethods(fs.readFileSync(path.join(dir, file), 'utf8')));
  }
  return [...new Set(defined)];
}

/**
 * The whole check.
 *
 * @returns {{called: string[], defined: string[], missing: string[]}}
 */
export function windowContract({ repo = REPO } = {}) {
  const app = windowSources({ repo });
  const called = windowMethods(app);
  const defined = backendMethodList({ repo });
  return { called, defined, missing: called.filter((m) => !defined.includes(m)) };
}
