# The backend contract this extension uses

The local harness backend (`aipass-bridge/harness/rpc.mjs`) is the only
surface this extension talks to. It is the same surface the desktop window
uses, so another editor — Neovim, Zed, anything — can be built on it.

Everything below was read out of the backend source
(`aipass-bridge/harness/rpc.mjs` and the domain modules under
`aipass-bridge/harness/rpc/`). Where the window already consumes a frame, the
window's spelling is the one written here.

---

## 1. Why not the bridge

The bridge's OpenAI-compatible endpoint (`http://127.0.0.1:8787/v1`) takes
ONE user message and owns the conversation server-side; an agent-style system
prompt is refused with a 403 by the edge's WAF. The endpoint therefore
declines the shape an IDE client requires — "I can't access your files" is
the shape of the refusal, not a bug.

The harness already sends the marker protocol as user messages, so it lives
inside that constraint. **Any client that wants to drive the agent talks to
the harness backend, not to the bridge.**

## 2. The transport

Two routes, one host. Both are loopback-only, and both carry the token.

| route | method | what it is |
|---|---|---|
| `http://127.0.0.1:8790/rpc` | `POST` | JSON-RPC: one call, one answer. |
| `http://127.0.0.1:8790/events` | `GET` | SSE: every harness event, tagged `ev: <name>`. |

### 2.1 Where the port comes from

1. `AIPASS_DESKTOP_PORT` — the launcher resolves the port from exactly this
   variable (`aipass-bridge/harness/launcher.mjs`, `resolveDesktopPort`), so a
   backend started with it is on that port whatever any file says.
2. `desktopPort` in `~/.aipass/settings.json` — the file every surface shares.
3. `8790` — the default.

A value that is not a port (not decimal digits, outside 1–65535) is ignored
rather than believed. The same home holds the token: `~/.aipass/.token`
(`$AIPASS_HOME/.token` overrides the home).

### 2.2 The token

- Read from `~/.aipass/.token`, trimmed.
- Sent as `Authorization: Bearer <token>`.
- **On both routes.** The `/events` stream accepts a header bearer as well as
  `?token=`; the header is the better shape, because a URL is the shape that
  ends up in a log.
- Never printed, never put in a URL, never given to a page. In this extension
  the token lives in the extension host and the webview never sees it.
- `AIPASS_REQUIRE_AUTH=0` turns the whole thing off (a test escape hatch; the
  backend warns at every boot).

### 2.3 The project header

Every `/rpc` call carries the project it is about:

```
x-aipass-project: C:\path\to\project
```

The backend holds one harness per project. Without the header, a second
window on another project would decide what this one reads — its sessions, its
file tree, its pending diffs — and its Apply button would write the other
project's staged edits. A call may also name the project in its params
(`project`, or `root` for `run`); **an explicit param wins over the header.**

### 2.4 The shape of a call

Request:

```json
{ "method": "run", "params": { "task": "…", "root": "C:\\path" } }
```

Answer:

```json
{ "ok": true,  "result": … }
{ "ok": false, "error": "…", "stage": "…" }
```

`stage` names the step that failed (the window shows it as "which door
closed"). A refusal comes back as HTTP 200 with `ok: false`; only the token
refusal is an HTTP 401, and an unknown method is an HTTP 404.

### 2.5 The event stream

```
GET /events
Accept: text/event-stream
Authorization: Bearer <token>
```

Frames:

```
event: <name>
id: <seq>
data: <json>

```

- `id` is the backend's monotonic sequence number. **A reconnect sends
  `Last-Event-ID` (or `?since=`), and the backend replays exactly what that
  listener missed** — a dropped stream costs a pause, not the middle of a run.
- `hello` arrives once, on connect.
- `ping` arrives every 15 s. It exists so a client can tell "the backend
  died" from "the model went quiet" — a long `RUN` streams nothing else for a
  while.

---

## 3. The methods this extension calls

The panel is allowed to call **only** this list; anything else is refused by
the extension host before it reaches the backend.

| method | params | answer |
|---|---|---|
| `status` | — | The state of the project: `root`, `bridge`, `extensions`, `extensionToken`, `model`, `provider`, `running`, `mode`, `pending[]`, `context`, `session`, `catalog`, `app`. |
| `snapshot` | — | `status` plus the session's `entries[]`, the `pending[]` and the `asks` — `{ permissions[], plan }`, the questions waiting for an answer. The restore after a reload. |
| `credits` | `force` (boolean, optional) | `{ limit, used, available }`. `force` refreshes the upstream quota instead of reading the cache. |
| `pending` | — | `[{ file, added, removed, deleted, isNew }]` — the staged changes. |
| `diff` | `file` | `{ file, diff, added, removed, isNew, deleted, before, after }` — one file's diff. |
| `apply` | `files` (array of project-relative names, optional) | `{ written, deleted, files[], checkpoint }`. **This is the only write.** The checkpoint is what makes it undoable. |
| `discard` | — | `{ dropped }` — the staged changes are thrown away. |
| `run` | `task`, `root`, `title` | `{ summary, stopReason, steps, spent, attempts, check, pending[] }`. The call answers when the run is over — the live frames arrive on the stream. |
| `cancel` | `root` | `{ ok, running, reason? }`. `running: false` means there was nothing to stop, and the client says so instead of pretending. |
| `permission.answer` | `id`, `decision` (`allow`/`always`/`deny`), `project` | `{ ok }`. |
| `plan.answer` | `ok` (boolean), `project` | `{ ok }`. |
| `browser.open` | `url` | `{ ok }` — opens a URL in the browser the extension lives in. |

The extension host calls one method that the panel does not:
`waf.table` → `{ pairs: [[source, flags, to], …] }` — the WAF restore table.
The placeholders the edge needs are put back with it before anything is read.

---

## 4. The events this extension consumes

Every frame carries the project it belongs to (`project`) and the session the
run writes to (`session`), except the backend-level ones.

**The rule about the project:** a run belongs to one project. A frame tagged
with another project must not be drawn in this panel — its `step` would fold
this answer and its `finished` would end this turn. **The questions are the
exception**: a `permission_request` or a `plan_request` that was dropped
would leave that run waiting for an answer nobody can see, so those are always
shown, and they name the project they belong to.

### 4.1 The transport

| event | payload | what it means |
|---|---|---|
| `hello` | `{ seq }` | The stream is open. |
| `ping` | `{}` | The backend is alive (every 15 s). |

### 4.2 The run

| event | payload | what it means |
|---|---|---|
| `task_start` | `{ task, maxSteps }` | The run has started. |
| `assistant_delta` | `{ text }` | A piece of the reply. **The text carries the markers** — the client strips them (see §6). |
| `reasoning_delta` | `{ text }` | A piece of the model's thinking. |
| `step` | `{ step, maxSteps, elapsed }` | The boundary between two replies: the bubble closes here. |
| `thinking` | `{ text }` | The step's headline. |
| `tool_start` | `{ kind, arg }` | A call was admitted for execution, in marker order, before its result. |
| `tool` | `{ kind, arg, ok, head, lines[], sources[], isLast }` | One tool call. `kind` is the wire name (`read`, `list`, `replace`, `write`, `run`, `web`, …). |
| `note` | `{ text }` | Something worth saying that is not a tool call. |
| `firewall_note` | `{ text }` | The edge refused something; the client is waiting it out. |
| `nudge` | `{ n }` | The reply carried no marker; the harness asks again. |
| `give_up` | `{}` | Three replies with no marker — the run stops. |
| `ignore_done` | `{}` | A DONE arrived before the results it asked for. |
| `stagnation` | `{ action, pattern, repeats, cycle }` | The loop is not moving. |
| `repeat_block` | `{ kind, count }` | An identical call was refused. |
| `verify_prompt` | `{ files[] }` | The model is asked to prove the change. |
| `check_start` | `{ files[], command }` | The checker starts. |
| `check_end` | `{ verdict, ran, skipped }` | `verdict` is `pass`, `fail` or null. |
| `lang_prompt` | `{ ratio, min }` | The reply's language was measured; one rewrite is asked for. |
| `budget` | `{ reason, used }` | A budget (tools / time / credits) was spent. |
| `step_limit` | `{}` | The step cap was reached. |
| `error` | `{ message }` | The run failed. |
| `todo` | `{ items: [{ text, done }] }` | The checklist. |
| `diff_update` | `{ changes[] }` | The staged changes changed — the same shape as `pending`. |
| `compacted` | `{ summary, memory }` | The conversation was rotated; the summary is what survived. |
| `inject_queued` | `{ n }` | A message the person typed mid-run entered the queue. |
| `injected` | `{ n }` | The queue was drained into a step’s paste. |
| `inject_orphaned` | `{ texts[] }` | The run ended first; the texts go back to the composer. |
| `helper_start` | `{ task, role, session }` | A helper began. |
| `helper_end` | `{ task, role, summary, prepared[], skipped[] }` | A helper finished. |
| `subagent_start` / `subagent_end` | `{ task, role, out }` | A background helper. |
| `plugin_call` | `{ marker, arg }` | A plugin marker ran. |
| `ask` | `{ text }` | The run paused on a question (the next message answers it). |
| `done_line` | `{ text, extra }` | **The DONE.** Say it once — the run's ending must not say it again. |
| `cancelled` | `{ running }` | The stop was heard. `running: false` means there was nothing to stop. |
| `finished` | `{ summary, steps, stopReason, spent, credits, check, changes[], todo[] }` | The run is over. |
| `run_stats` | `{ … }` | The run's counters (tool calls, refusals, nudges, credits). |

### 4.3 The questions the backend asks

| event | payload | the answer |
|---|---|---|
| `permission_request` | `{ id, kind, arg, preview, risk }` | `permission.answer` with `{ id, decision, project }`, where `decision` is `allow`, `always` or `deny`. `risk` is `shell`, `exfil` or a write. |
| `plan_request` | `{}` | `plan.answer` with `{ ok, project }`. |

Both carry the `project` they belong to. **The answer must carry it too** —
an explicit `project` in the params wins over the `x-aipass-project` header,
so a question about another project is answered to the right run.

### 4.4 The machine around the run

| event | payload | what it means |
|---|---|---|
| `needs_tab` | `{ url, reason }` | The bridge has no logged-in chat tab. The one failure with a one-click fix. |
| `tab_opened` | `{ url, opened }` | The tab was opened. |
| `session` | `{ id, title, file }` | The run opened a session. |
| `session_opened` / `session_forked` | the session's meta | The session changed. |
| `conversation` | `{ id, temporary, resumed, rotated, scratch }` | The upstream conversation changed. |
| `project` | `{ root }` | The backend's current project moved. |
| `settings` | the settings | The settings file changed. |
| `plugins` | the plugin listing | The plugins changed. |
| `applied` | `{ written, deleted, files[] }` | Changes were written to the disk. |
| `discarded` | `{ files }` | The staged changes were thrown away. |

### 4.5 The stop reasons

`finished.stopReason` is one of `done`, `cancelled`, `plan-rejected`, `error`,
`stalled`, `stagnation`, `credit-limited`, `tools-limited`, `time-limited`,
`steps`, `done-unverified`, `ask`.

---

## 5. The rules a client must keep

These are the backend's rules, and a client that breaks them breaks the run —
not just its own view.

1. **A run never writes to the disk.** Every change is a proposal in the
   overlay. The only write is `apply`.
2. **A file the human unticked stays unticked.** The pending list is rebuilt
   on every `diff_update`; a reset to "checked" would re-select exactly the
   files they said no to.
3. **A DONE is said once.** `done_line` carries it; `finished.summary` must
   not say it again.
4. **Markers are wire protocol, never rendered text.** They are stripped from
   the prose (see §6).
5. **Both transports carry the token.** The desktop law applies to every
   client, not only to the window.
6. **A stop says what it stopped.** `cancel` answers `running: false` when
   there was nothing to stop — say so instead of pretending.
7. **Nobody listening means deny, not hang** (the harness's own rule). A
   client that drops a question leaves that run waiting.

---

## 6. The prose, cleaned

Two things stand between the model's words and the reader's screen.

**The markers.** The model's reply carries the protocol as prose
(`NEED file src/app.js`, `EDIT … END`, `DONE …`). The client must not show
them: every call already has its own row, so showing the markers would show
every change twice. The grammar is the harness's
(`aipass-bridge/harness/protocol.mjs`, `MARKER_LINE` and `parse()`); the
window keeps a mirror in `desktop/ui/markers.js`, and the repository's suite
keeps the two honest against each other
(`test/ui-markers.test.mjs`).

This extension keeps a third mirror, in `ide-extension/lib/protocol.js`
(`MARKER_KEYWORDS`). It has no parity test of its own — but its self-test
compares that keyword list against the harness's own `MARKER_LINE` whenever
the harness is next to the extension, so a marker added to the harness fails
the self-test until the mirror is updated. The keywords are:

```
NEED  SEARCH  GLOB  SYMBOLS  DEF  REFS  SKILL  GIT  VERIFY  FETCH  WEB
DELETE  MOVE  EDIT  CREATE  ATTACH  FIND  NEW  END  RUN  PLAN  TODO
SUBAGENT  TASK  ASK  DONE  JOBS
```

`EDIT`, `CREATE`, `RUN`, `PLAN`, `TODO` and `SUBAGENT` take a body that ends
with `END`; the body is dropped too, the way the window drops it — the code
the model proposes is in the tool row, not in the prose.

**The wire spellings.** The edge in front of `de.aipass.net` needs
placeholders in the text it takes (the WAF table,
`aipass-bridge/harness/waf.mjs`), so a URL can arrive as `HTTPS-URL…`. The
table belongs to the harness: ask for it with `waf.table` and apply it to the
text before showing it. The window does the same
(`desktop/ui/waf-restore.js`).

---

## 7. Building another client on this

Neovim, Zed, a second window — the contract above is all it takes:

1. Read the port and the token (§2.1, §2.2).
2. `POST /rpc` with the bearer and the project header.
3. `GET /events` with the bearer, and reconnect with `Last-Event-ID`.
4. Render the prose and the tool rows; strip the markers; restore the wire
   spellings.
5. Answer `permission_request` and `plan_request` — with the project.
6. Apply only on an explicit `apply`.

Nothing in the contract requires VS Code, a webview, or a window manager.
