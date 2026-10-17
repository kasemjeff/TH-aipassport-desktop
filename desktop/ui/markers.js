/* What the transcript shows: the model's prose, without the wire traffic.
 *
 * The harness protocol is markers-in-prose: the model says "EDIT file … END"
 * as its way of calling a tool, and the loop answers every call with its own
 * `tool` event. The window renders those events as their own rows, so the
 * bubble must not repeat the markers back at the reader — a live run would
 * otherwise show every change twice, once as raw protocol and once as the row
 * that actually happened.
 *
 * `scan()` walks a reply call for call, mirroring protocol.parse() — the
 * parity test in test/ui-markers.test.mjs drives both against the same corpus,
 * so if the protocol grows a marker and this file does not, the suite fails
 * instead of a bubble quietly showing raw wire. `transcript()` is the same
 * walk with the marker lines (and the bodies of block markers) dropped.
 * Quoted examples in a fenced block stay: inside a fence a marker is a
 * quotation, never a call. One honest gap: a plugin marker is known here only
 * after plugins.list has reported it, and its body is eaten only when the
 * report says takesBody.
 */

const FENCE_LINE = /^\s*(```|~~~)/;

// The single-line calls, mirrored from protocol.parse() in its own order.
const SINGLE = [
  // `dir`/`list`/`ls` all mean the listing; `file` means a read. Mirrors
  // parse()'s alias branch.
  { re: /^\s*NEED\s+(dir|list|ls|file)\s+(.+?)\s*$/i, pick: (m) => ({ kind: m[1].toLowerCase() === 'file' ? 'read' : 'list', arg: m[2].trim() }) },
  // A bare listing word with the path forgotten — the project root.
  { re: /^\s*NEED\s+(?:dir|list|ls)\s*$/i, pick: () => ({ kind: 'list', arg: '.' }) },
  // The bare file shape — `NEED events.mjs` — mirroring parse()'s fallback.
  { re: /^\s*NEED\s+([^\s]+(?: \d+-\d+)?)\s*$/i, pick: (m) => ({ kind: 'read', arg: m[1].trim() }) },
  { re: /^\s*SEARCH\s+(.+?)\s*$/i, pick: (m) => ({ kind: 'search', arg: m[1].trim() }) },
  { re: /^\s*GLOB\s+(.+?)\s*$/i, pick: (m) => ({ kind: 'glob', arg: m[1].trim() }) },
  { re: /^\s*SKILL\s+(.+?)\s*$/i, pick: (m) => ({ kind: 'skill', arg: m[1].trim() }) },
  { re: /^\s*GIT\s+(.+?)\s*$/i, pick: (m) => ({ kind: 'git', arg: m[1].trim() }) },
  { re: /^\s*FETCH\s+(.+?)\s*$/i, pick: (m) => ({ kind: 'fetch', arg: m[1].trim() }) },
  { re: /^\s*WEB\s+(.+?)\s*$/i, pick: (m) => ({ kind: 'web', arg: m[1].trim() }) },
  { re: /^\s*ATTACH\s+(.+?)\s*$/i, pick: (m) => ({ kind: 'attach', arg: m[1].trim() }) },
  { re: /^\s*DELETE\s+(.+?)\s*$/i, pick: (m) => ({ kind: 'delete', arg: m[1].trim() }) },
  { re: /^\s*MOVE\s+(.+?)\s*$/i, pick: (m) => ({ kind: 'move', arg: m[1].trim() }) },
];

const EDIT_LINE = /^\s*EDIT\s+(.+?)\s*$/i;
const CREATE_LINE = /^\s*CREATE\s+(.+?)\s*$/i;
const RUN_LINE = /^\s*RUN\s*$/i;
const PLAN_LINE = /^\s*PLAN\s*$/i;
const TODO_LINE = /^\s*TODO\s*$/i;
const SUBAGENT_LINE = /^\s*SUBAGENT\s*$/i;
// Mirrors parse()'s DONE tail: a heading or emphasis wrapped around the word is
// still a DONE, because the model reaches for "## DONE" the moment it formats.
const DONE_LINE = /^\s*(?:\*{1,3}|#{1,6}\s*)?DONE\b[:\s\u2014\u2013-]*(.*)$/i;

/** Plugin reports come as marker strings or {marker, takesBody} records. */
const normalizePlugins = (plugins = []) => plugins
  .map((p) => (typeof p === 'string' ? { marker: p } : p))
  .filter((p) => p?.marker);

// The window re-walks the whole reply on every streamed paint, so the stop
// line regexes and the plugin marker regexes are compiled once and kept here:
// the walk used to build a fresh RegExp per line per marker, which made every
// repaint grow with the reply's length even for text that never changed.
const STOP_RES = new Map();
const stopRe = (stops) => {
  const key = stops.join('|');
  let re = STOP_RES.get(key);
  if (!re) { re = new RegExp(`^\\s*(?:${key})\\s*$`, 'i'); STOP_RES.set(key, re); }
  return re;
};
const PLUGIN_RES = new Map();
const pluginRe = (marker) => {
  let re = PLUGIN_RES.get(marker);
  if (!re) { re = new RegExp(`^\\s*${marker}\\b\\s*(.*)$`, 'i'); PLUGIN_RES.set(marker, re); }
  return re;
};

/**
 * One pass over a reply: `kept` is the lines a reader should see, `calls` is
 * what the loop would act on. The consumption rules are copied from
 * protocol.parse() line for line; the parity test is what keeps the copy
 * honest.
 */
function walk(reply, plugins) {
  const lines = String(reply ?? '').split('\n');
  const kept = [];
  const calls = [];
  let inFence = false;
  let i = 0;
  const pluginList = normalizePlugins(plugins); // normalised once per walk, not once per line

  // Skip to the next stop line — END, or one of the EDIT block's stops. The
  // marker regexes tolerate trailing whitespace (\r included) exactly as the
  // protocol does.
  const skipUntil = (stops) => {
    const re = stopRe(stops);
    while (i < lines.length && !re.test(lines[i])) i += 1;
  };
  const skipEnd = () => { if (/^\s*END\s*$/i.test(lines[i] ?? '')) i += 1; };

  while (i < lines.length) {
    const line = lines[i];

    // Inside a fence the reply is quoting: markers shown as examples are kept
    // as prose and never scanned.
    if (FENCE_LINE.test(line)) { inFence = !inFence; kept.push(line); i += 1; continue; }
    if (inFence) { kept.push(line); i += 1; continue; }

    let hit = null;
    for (const s of SINGLE) {
      const m = s.re.exec(line);
      if (m) { hit = s.pick(m); break; }
    }
    if (hit) { calls.push(hit); i += 1; continue; }

    let m = EDIT_LINE.exec(line);
    if (m) {
      i += 1;
      if (/^\s*FIND\s*$/i.test(lines[i] ?? '')) i += 1;
      skipUntil(['NEW', 'END']);
      if (/^\s*NEW\s*$/i.test(lines[i] ?? '')) i += 1;
      skipUntil(['END']);
      skipEnd();
      calls.push({ kind: 'replace', arg: m[1].trim() });
      continue;
    }
    m = CREATE_LINE.exec(line);
    if (m) {
      i += 1; skipUntil(['END']); skipEnd();
      calls.push({ kind: 'write', arg: m[1].trim() });
      continue;
    }
    if (RUN_LINE.test(line)) { i += 1; skipUntil(['END']); skipEnd(); calls.push({ kind: 'run', arg: '' }); continue; }
    if (PLAN_LINE.test(line)) { i += 1; skipUntil(['END']); skipEnd(); calls.push({ kind: 'plan', arg: '' }); continue; }
    if (TODO_LINE.test(line)) { i += 1; skipUntil(['END']); skipEnd(); calls.push({ kind: 'todo', arg: '' }); continue; }
    if (SUBAGENT_LINE.test(line)) { i += 1; skipUntil(['END']); skipEnd(); calls.push({ kind: 'subagent', arg: '' }); continue; }

    m = DONE_LINE.exec(line);
    if (m) { i += 1; calls.push({ kind: 'done', arg: m[1].trim() }); continue; }

    // Plugin markers last: a built-in name is never shadowed by one.
    let matchedPlugin = false;
    for (const p of pluginList) {
      const pm = pluginRe(p.marker).exec(line);
      if (!pm) continue;
      i += 1;
      if (p.takesBody) { skipUntil(['END']); skipEnd(); }
      calls.push({ kind: 'plugin', name: p.marker, arg: pm[1].trim() });
      matchedPlugin = true;
      break;
    }
    if (matchedPlugin) continue;

    kept.push(line);
    i += 1;
  }

  return { kept, calls };
}

/** The calls a reply would make — the same list protocol.parse() returns. */
export function scan(reply, { plugins = [] } = {}) {
  return walk(reply, plugins).calls;
}

/** The reply's prose, with every marker call (headers and bodies) dropped. */
export function transcript(reply, plugins = []) {
  return walk(reply, plugins).kept.join('\n').trim();
}
