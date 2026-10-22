// One pre-dispatch shape check for every marker call the loop is about to run.
//
// The parser (protocol.mjs) already refuses most malformed replies, but the
// dispatch path has three sources — built-in tools, plugin tools and MCP tools
// — and each one used to teach shape with its own wording. That is how the same
// mistake reads differently depending on which surface a project happens to
// have installed, and how a newly added plugin silently inherits no shape
// checks at all. `validateCall` is the one place that decides whether a call is
// answerable; `execute` (loop.mjs) runs it before permissions, before a tool
// sees an argument, and before a plugin's own code is invoked.
//
// It checks shape, not policy or content: an empty RUN block is a shape
// mistake, an unreadable file is a tool result, and `RUN rm -rf` is the
// permission engine's business. Tools keep their own guards for direct callers
// (tests build a table and call it); in the loop no invalid call reaches them.

/** The markers the loop itself owns plus the built-in tool table. */
export const BUILTIN_KINDS = new Set([
  'skill', 'list', 'read', 'write', 'replace', 'search', 'run', 'glob', 'git',
  'fetch', 'delete', 'move', 'attach', 'web', 'symbols', 'def', 'refs', 'recall',
  'plan', 'todo', 'subagent', 'jobs', 'done', 'ask', 'verify',
]);

/**
 * Argument-required kinds and the sentence that teaches each one. Wording
 * matches the tool's own guard where one exists, so the model sees the same
 * correction whether the call was caught here or downstream.
 */
const ARG_GUARDS = {
  read: 'err: NEED needs a file or directory path.',
  search: 'err: give me some text to search for. (SEARCH -i text matches without letter case.)',
  glob: 'err: give me a glob pattern, e.g. **/*.ts',
  git: 'err: give me a git subcommand, e.g. status',
  fetch: 'err: give me a URL to fetch, starting with http:// or https://',
  delete: 'err: give me a file path to delete.',
  move: 'err: usage: MOVE <from> <to>',
  attach: 'err: give me a file path to attach.',
  web: 'err: give me a query to search for.',
  def: 'err: DEF needs a name — DEF foo',
  refs: 'err: REFS needs a name — REFS foo',
  recall: 'err: RECALL needs something to look for — RECALL <what you want to remember>',
};

/**
 * Return an `err: …` string when `call` cannot be dispatched, or null when it
 * can. A plugin marker travels through the same door as a built-in: the marker
 * must be in the run's table and a runner must exist, so an MCP tool that was
 * never connected answers with the same sentence a missing plugin does.
 *
 * @param {object} call
 * @param {object} [table]
 * @param {Array<{marker:string}>} [table.pluginTools]
 * @param {Function|null} [table.runPluginTool]
 */
export function validateCall(call, { pluginTools = [], runPluginTool = null } = {}) {
  if (!call || typeof call !== 'object') return 'err: marker call carried no shape.';
  const kind = String(call.kind ?? '').trim();

  if (kind === 'plugin') {
    const name = String(call.name ?? '').trim();
    if (!name) return 'err: a plugin marker was called without a name.';
    const declared = pluginTools.find((t) => String(t?.marker ?? '') === name);
    if (!declared || !runPluginTool) return `err: no plugin tool named ${name} is installed`;
    return null;
  }

  if (!BUILTIN_KINDS.has(kind)) {
    return `err: unknown marker "${kind}" — the preamble lists the markers this run accepts.`;
  }

  const arg = call.arg == null ? '' : String(call.arg);
  if (ARG_GUARDS[kind] && !arg.trim()) return ARG_GUARDS[kind];
  if (kind === 'move' && arg.trim().split(/\s+/).length < 2) {
    return 'err: MOVE needs a source and a destination: MOVE <from> <to>.';
  }

  // Body-shaped kinds. A body is the marker's payload; a missing one is a
  // parse mistake, while an empty one is sometimes deliberate (CREATE writes
  // an empty file, a TODO line is optional), so only the required ones gate.
  if (kind === 'run' && !String(call.body ?? '').trim()) {
    return 'err: the RUN block has no command. One command per RUN, e.g. RUN\nnode check.mjs\nEND.';
  }
  if (kind === 'write' && typeof call.body !== 'string') {
    return 'err: CREATE needs its file body between the marker and END.';
  }
  if (kind === 'replace' && (!Array.isArray(call.body) || call.body.length < 2
      || typeof call.body[0] !== 'string' || typeof call.body[1] !== 'string')) {
    return 'err: EDIT needs the exact text under FIND and its replacement under NEW.';
  }
  if (kind === 'subagent' && !String(call.body ?? '').trim()) {
    return 'err: give the helper a task, on a `task:` line inside SUBAGENT';
  }

  return null;
}

export default validateCall;
