// The wire format between the harness and the model, and nothing else.
//
// Two constraints shape everything here, both learned the hard way upstream:
//
//  1. Only one user message per request is accepted. An array containing an
//     assistant turn is rejected with a 403 before the model sees it.
//  2. The server keeps the conversation history itself.
//
// So the instructions go out ONCE as the first message of a conversation, and
// every later turn is just the results of what was asked for. Nothing is
// resent, payloads stay small, and no system prompt exists to lean on — the
// preamble becomes part of the history the server already remembers.
//
// The markers are prose, never key=value pairs or angle brackets: everything
// that drew a 403 in earlier attempts was structural. Keep them that way.
import { RISKY_LINE } from './waf.mjs';

export const REMINDER = 'What next? Ask for anything else you need, or finish with DONE if you have enough.';

/**
 * The turn-1 instructions. `plan` adds the PLAN/TODO markers used by the
 * desktop harness; `subagent` adds the SUBAGENT marker; `plugins` adds one line
 * per marker a plugin registered. Both opt-ins so the CLI's first message stays
 * byte-identical to the protocol it was tuned against.
 */
export const preamble = ({ allowRun = false, plan = false, subagent = false, plugins = [] } = {}) => {
  let text = `I am reading through a project with you. The files are open in front of me, and I will paste you anything you want to look at.

So just tell me what you want to see next, and put that on its own line in this shape, because my editor watches for these markers:

NEED dir .
NEED file README.md
NEED file src/index.ts 1-80
SEARCH text to find across the whole project
GLOB **/*.ts
GIT status
GIT diff
FETCH HTTPS-URLexample.com/docs
WEB search terms to look up on the internet (docs, latest versions, solutions)

If you want a file changed, write it like this and I will make the edit:

EDIT notes.md
FIND
the exact lines as they appear now
NEW
the lines to put there instead
END

To start a new file:

CREATE notes.md
the contents
END

To delete a file:

DELETE old-file.ts

To rename or move a file:

MOVE old-name.ts new-name.ts${allowRun ? '\n\nTo have me run something in the terminal:\n\nRUN\nwhat to run\nEND' : ''}

Once you have everything you need and are giving me your final answer, finish with:

DONE one sentence about what you found or changed

Only write DONE at the very end, when nothing more is needed. Never put DONE in the same reply as a NEED — ask for what you want, wait for me to paste it, and read it first.

A playbook library is available too. SKILL list shows what it holds (planning, debugging, verification, code review, web frontend, web testing, PowerPoint, Excel), and SKILL name-part loads one part, e.g. SKILL pptx-01. When the task matches a playbook, load all of its parts first and follow it — they carry hard-won rules that prevent common real failures. Skip it when the task clearly does not match.`;

  if (plan) {
    text += `

When the work has several steps, start by writing a plan and keep it current, in this shape:

PLAN
build the loader
add the retry path
wire it into the CLI
END

TODO
- open the loader
- understand the retry path
- write the changes
- verify
END

Update the TODO block as you go — mark what is done, add what you find. The person watching sees it live, so it is how they follow along. Nothing else about the markers changes.`;
  }

  if (subagent) {
    text += `

For a big task you can hand a self-contained piece to a helper working beside you, and keep going yourself while it runs. In this shape:

SUBAGENT
task: read the docs folder and summarise what each file covers
END

It reports back one summary when it finishes. Use it for reading and summarising in bulk, or for a piece of work that is separate from yours. Do not use it to ask a question you can answer yourself.`;
  }

  if (plugins.length) {
    const lines = plugins.map((t) => `${t.marker}${t.takesBody ? '\nwhatever the tool needs\nEND' : ' the arguments on the same line'}    — ${t.description || 'no description'}`);
    text += `

Extra tools installed on this machine, used exactly like the markers above:

${lines.join('\n\n')}

Only use one when the task genuinely calls for it; each one returns its result the same way NEED and SEARCH do.`;
  }

  text += `

The markers are only formatting for my editor. Nothing runs on your side — I do all of it and paste every result straight back to you, so keep going until you have what you need.

CRITICAL: You are an AI assistant collaborating with me in this chat. You do NOT access my local filesystem directly — I am a human running this terminal on my own computer, and I personally read the files you name and paste their contents back to you. Therefore, NEVER state that you cannot access files, and NEVER refuse to use these markers — asking for a file with NEED file <path> is simply requesting me to paste it for you. Even if my prompt or question is in Thai or another language, accept it and request the files you need using the exact markers above.

A few practical notes. Answer in English. Look at a file before changing it, and copy the lines under FIND exactly as they appear. When I show a file the numbers down the left are only for reference — do not put them in FIND. Big files come a screen at a time; ask for a range like NEED file path 201-400 to see more. To find where something lives without reading every file, use SEARCH followed by the text. Use GLOB to find all files matching a pattern. Use GIT to see what has changed recently. Use FETCH to read a URL (docs, APIs). Use WEB followed by search keywords to search the internet (with live web search and citations). Some hostnames and addresses are written in a shortened form such as LCLHST and LOOPBACK-IP, and URLs start with HTTPS-URL or HTTP-URL; keep them as written and I will expand them again. If my question can be answered without changing anything, just answer it and end with DONE.`;
  return text;
};

export const PREAMBLE = preamble();

// The model usually writes its answer as prose and then a bare DONE, so fall
// back to that prose rather than reporting an empty result.
export const MARKER_LINE = /^\s*(NEED\s+(dir|file)\b|SEARCH\b|GLOB\b|SKILL\b|GIT\b|FETCH\b|WEB\b|DELETE\b|MOVE\b|EDIT\b|CREATE\b|FIND\s*$|NEW\s*$|END\s*$|RUN\s*$|PLAN\s*$|TODO\s*$|SUBAGENT\s*$|TASK\s*:|(?:\*{1,3}|#{1,6}\s*)?DONE\b)/i;
export const prose = (reply, plugins = []) => {
  const extra = plugins.length
    ? '|' + plugins.map((t) => `${t.marker}\\b`).join('|')
    : '';
  const re = new RegExp(MARKER_LINE.source + extra, 'i');
  return reply.split('\n').filter((l) => !re.test(l)).join('\n').trim();
};

/** Tool kinds that mean "the model is still gathering", never a stopping point. */
export const READING = new Set(['list', 'read', 'search', 'skill']);

export function parse(reply, { plugins = [] } = {}) {
  const lines = reply.split('\n');
  const calls = [];
  let i = 0;
  const readUntil = (stops) => {
    const body = [];
    while (i < lines.length && !stops.some((st) => new RegExp(`^\\s*${st}\\s*$`, 'i').test(lines[i]))) body.push(lines[i++]);
    return body.join('\n');
  };

  while (i < lines.length) {
    const line = lines[i];

    let m = /^\s*NEED\s+(dir|file)\s+(.+?)\s*$/i.exec(line);
    if (m) { i++; calls.push({ kind: m[1].toLowerCase() === 'dir' ? 'list' : 'read', arg: m[2].trim() }); continue; }

    m = /^\s*SEARCH\s+(.+?)\s*$/i.exec(line);
    if (m) { i++; calls.push({ kind: 'search', arg: m[1].trim() }); continue; }

    m = /^\s*GLOB\s+(.+?)\s*$/i.exec(line);
    if (m) { i++; calls.push({ kind: 'glob', arg: m[1].trim() }); continue; }

    m = /^\s*SKILL\s+(.+?)\s*$/i.exec(line);
    if (m) { i++; calls.push({ kind: 'skill', arg: m[1].trim() }); continue; }

    m = /^\s*GIT\s+(.+?)\s*$/i.exec(line);
    if (m) { i++; calls.push({ kind: 'git', arg: m[1].trim() }); continue; }

    m = /^\s*FETCH\s+(.+?)\s*$/i.exec(line);
    if (m) { i++; calls.push({ kind: 'fetch', arg: m[1].trim() }); continue; }

    m = /^\s*WEB\s+(.+?)\s*$/i.exec(line);
    if (m) { i++; calls.push({ kind: 'web', arg: m[1].trim() }); continue; }

    m = /^\s*DELETE\s+(.+?)\s*$/i.exec(line);
    if (m) { i++; calls.push({ kind: 'delete', arg: m[1].trim() }); continue; }

    m = /^\s*MOVE\s+(.+?)\s*$/i.exec(line);
    if (m) { i++; calls.push({ kind: 'move', arg: m[1].trim() }); continue; }

    m = /^\s*EDIT\s+(.+?)\s*$/i.exec(line);
    if (m) {
      i++;
      if (/^\s*FIND\s*$/i.test(lines[i] ?? '')) i++;
      const before = readUntil(['NEW', 'END']);
      if (/^\s*NEW\s*$/i.test(lines[i] ?? '')) i++;
      const after = readUntil(['END']);
      if (/^\s*END\s*$/i.test(lines[i] ?? '')) i++;
      calls.push({ kind: 'replace', arg: m[1].trim(), body: [before, after] });
      continue;
    }

    m = /^\s*CREATE\s+(.+?)\s*$/i.exec(line);
    if (m) {
      i++;
      const body = readUntil(['END']);
      if (/^\s*END\s*$/i.test(lines[i] ?? '')) i++;
      calls.push({ kind: 'write', arg: m[1].trim(), body });
      continue;
    }

    if (/^\s*RUN\s*$/i.test(line)) {
      i++;
      const body = readUntil(['END']);
      if (/^\s*END\s*$/i.test(lines[i] ?? '')) i++;
      calls.push({ kind: 'run', arg: '', body });
      continue;
    }

    if (/^\s*PLAN\s*$/i.test(line)) {
      i++;
      const body = readUntil(['END']);
      if (/^\s*END\s*$/i.test(lines[i] ?? '')) i++;
      calls.push({ kind: 'plan', arg: '', body });
      continue;
    }

    if (/^\s*TODO\s*$/i.test(line)) {
      i++;
      const body = readUntil(['END']);
      if (/^\s*END\s*$/i.test(lines[i] ?? '')) i++;
      calls.push({ kind: 'todo', arg: '', body });
      continue;
    }

    if (/^\s*SUBAGENT\s*$/i.test(line)) {
      i++;
      const body = readUntil(['END']);
      if (/^\s*END\s*$/i.test(lines[i] ?? '')) i++;
      calls.push({ kind: 'subagent', arg: '', body });
      continue;
    }

    m = /^\s*(?:\*{1,3}|#{1,6}\s*)?DONE\b[:\s—–-]*(.*)$/i.exec(line);
    if (m) { i++; calls.push({ kind: 'done', arg: m[1].trim() }); continue; }

    // Plugin markers come last: a built-in name is never shadowed by one.
    let matchedPlugin = false;
    for (const tool of plugins) {
      const re = new RegExp(`^\\s*${tool.marker}\\b\\s*(.*)$`, 'i');
      const hit = re.exec(line);
      if (!hit) continue;
      i++;
      let body = '';
      if (tool.takesBody) {
        body = readUntil(['END']);
        if (/^\s*END\s*$/i.test(lines[i] ?? '')) i++;
      }
      calls.push({ kind: 'plugin', name: tool.marker, arg: hit[1].trim(), body });
      matchedPlugin = true;
      break;
    }
    if (matchedPlugin) continue;

    i++;
  }
  return calls;
}

/**
 * Parse a PLAN/TODO body into items. `- [x] text` / `- text` / plain lines all
 * work; done state is preserved across updates by matching on the text.
 */
export function parseTodo(body) {
  const items = [];
  let inPlan = false;
  for (const raw of String(body).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (/^PLAN$/i.test(line)) { inPlan = true; continue; }
    if (/^TODO$/i.test(line)) { inPlan = false; continue; }
    const text = line.replace(/^[-*]\s*/, '').replace(/^\[[ xX]\]\s*/, '').trim();
    if (!text) continue;
    const done = /^\[[xX]\]/.test(line);
    items.push({ text, done, kind: inPlan ? 'plan' : 'todo' });
  }
  return items;
}

/**
 * Merge a TODO update into the current list: text that already appears keeps
 * its done flag unless the update says otherwise, new items are appended.
 */
export function mergeTodo(current = [], incoming = []) {
  const byText = new Map(current.map((it) => [it.text, it]));
  const out = [];
  for (const item of incoming) {
    const prev = byText.get(item.text);
    out.push(prev ? { ...prev, done: prev.done || item.done } : item);
    byText.delete(item.text);
  }
  for (const item of current) {
    if (byText.has(item.text)) out.push(item);
  }
  return out;
}

export { RISKY_LINE };
