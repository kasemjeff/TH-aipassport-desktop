// The one pre-dispatch shape check (harness/validate.mjs): built-in tools,
// plugin markers and MCP tools all pass through `validateCall` before any
// implementation sees an argument. These tests pin the contract the loop
// relies on — a malformed call returns an `err: …` sentence, a well-shaped one
// returns null — including the table lookup that makes an uninstalled plugin
// and an unconnected MCP tool answer identically.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCall, BUILTIN_KINDS } from '../harness/validate.mjs';

test('every built-in marker the protocol can produce passes its shape check', () => {
  const valid = [
    { kind: 'skill', arg: 'setup', body: '' },
    { kind: 'list', arg: '.' },
    { kind: 'read', arg: 'a.mjs' },
    { kind: 'write', arg: 'a.mjs', body: '' },
    { kind: 'replace', arg: 'a.mjs', body: ['old', 'new'] },
    { kind: 'search', arg: 'needle' },
    { kind: 'run', arg: '', body: 'node check.mjs' },
    { kind: 'glob', arg: '**/*.ts' },
    { kind: 'git', arg: 'status --short' },
    { kind: 'fetch', arg: 'https://example.com' },
    { kind: 'delete', arg: 'old.mjs' },
    { kind: 'move', arg: 'a.mjs b.mjs' },
    { kind: 'attach', arg: 'shot.png' },
    { kind: 'web', arg: 'node 24 release notes' },
    { kind: 'symbols', arg: 'src' },
    { kind: 'def', arg: 'runTask' },
    { kind: 'refs', arg: 'runTask' },
    { kind: 'plan', arg: '', body: 'do the thing' },
    { kind: 'todo', arg: '', body: 'tick one' },
    { kind: 'subagent', arg: '', body: 'task: check the test' },
    { kind: 'jobs', arg: '' },
    { kind: 'done', arg: 'finished' },
    { kind: 'ask', arg: 'which one?' },
  ];
  for (const call of valid) {
    assert.equal(validateCall(call), null, `${call.kind} should pass its shape check`);
  }
  for (const call of valid) assert.ok(BUILTIN_KINDS.has(call.kind), `${call.kind} is a known kind`);
});

test('a missing argument is refused with the tool\u2019s own sentence', () => {
  const wanted = [
    ['read', /NEED needs a file or directory path/],
    ['search', /give me some text to search for/],
    ['glob', /give me a glob pattern/],
    ['git', /give me a git subcommand/],
    ['fetch', /give me a URL/],
    ['delete', /give me a file path to delete/],
    ['attach', /give me a file path to attach/],
    ['web', /give me a query to search for/],
    ['def', /DEF needs a name/],
    ['refs', /REFS needs a name/],
  ];
  for (const [kind, re] of wanted) {
    const msg = validateCall({ kind, arg: '   ' });
    assert.ok(msg, `${kind} with a blank argument should be refused`);
    assert.match(msg, /^err:/);
    assert.match(msg, re);
  }
  assert.match(validateCall({ kind: 'move', arg: 'only-one.mjs' }), /MOVE <from> <to>/);
});

test('a missing body is refused before a tool can throw on it', () => {
  assert.match(validateCall({ kind: 'run', arg: '', body: '   ' }), /RUN block has no command/);
  assert.match(validateCall({ kind: 'subagent', arg: '', body: '' }), /give the helper a task/);
  assert.match(validateCall({ kind: 'write', arg: 'a.mjs', body: undefined }), /CREATE needs its file body/);
  assert.match(validateCall({ kind: 'replace', arg: 'a.mjs', body: ['only-find'] }), /EDIT needs the exact text/);
  // Deliberate empties pass: CREATE writes an empty file, and a PLAN with no
  // body is the model noting nothing — the loop already answers both without
  // error, and the validator must not invent a shape the protocol allows.
  assert.equal(validateCall({ kind: 'write', arg: 'empty.txt', body: '' }), null);
  assert.equal(validateCall({ kind: 'plan', arg: '', body: '' }), null);
});

test('plugin and MCP calls share the installed-table check', () => {
  const mcp = [{ marker: 'MCP__docs__search', takesBody: false, plugin: 'mcp' }];
  const runner = async () => 'ok';
  assert.equal(validateCall({ kind: 'plugin', name: 'MCP__docs__search', arg: 'needle' }, { pluginTools: mcp, runPluginTool: runner }), null);
  assert.match(
    validateCall({ kind: 'plugin', name: 'MCP__docs__search', arg: 'needle' }, { pluginTools: [], runPluginTool: runner }),
    /^err: no plugin tool named MCP__docs__search is installed$/,
  );
  assert.match(
    validateCall({ kind: 'plugin', name: 'NOTE', arg: '' }, { pluginTools: mcp, runPluginTool: null }),
    /^err: no plugin tool named NOTE is installed$/,
  );
  assert.match(validateCall({ kind: 'plugin', name: '', arg: '' }, { pluginTools: mcp, runPluginTool: runner }), /without a name/);
});

test('an unknown marker is refused instead of reaching an undefined function', () => {
  const msg = validateCall({ kind: 'teleport', arg: 'now' });
  assert.match(msg, /^err: unknown marker "teleport"/);
  assert.equal(validateCall(null), 'err: marker call carried no shape.');
});
