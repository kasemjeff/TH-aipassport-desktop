# Event map

Every event the harness emits, who fires it, and who reads it.

The bus is `aipass-bridge/harness/events.mjs`: one `Emitter` per harness,
subscribers that never break a run, and the backend's bounded `EventFanout`
that carries every frame to the windows over SSE (with a replay buffer and a
`fell_behind` notice; `hello` and `ping` are transport frames of the same
stream and are not in the tables). A plugin watches with `ctx.events.on(type,
fn)` (`harness/plugins.mjs`); a window listens with `onRun`/`onAny`
(`desktop/ui/app.js`), which also filter frames by project and session.

**This map is a contract, not a description.** `test/event-map.test.mjs`
scans `harness/` for every `emit('type')` literal and requires the table
below to name exactly that set — a renamed or new event fails the suite until
the table says so, the same way a renamed test fails the `Verify:` anchors.

## The run's life

| event | fired by | what it says | read by |
|---|---|---|---|
| `task_start` | loop | a run begins: the task text and the step cap | window (bar + transcript), plugins |
| `step` | loop | a reply landed and was parsed: step n, elapsed | window (step note), plugins |
| `step_limit` | loop | the run reached `maxSteps` | window, plugins |
| `thinking` | loop | the first line of a reply's prose | window (bubble headline) |
| `done_line` | loop | the run's closing sentence, said exactly once | window (result row), CLI |
| `ask` | loop | the run paused on a question for the person | window, CLI |
| `nudge` | loop | a reply had no marker: the nudge count | window, plugins |
| `give_up` | loop | the third nudge or a guard ceiling: the run stops | window, plugins |
| `ignore_done` | loop | a DONE rode a reply that still had work in it | window, plugins |
| `error` | loop/send | a failure the run could not heal, with its message | window, CLI |
| `finished` | loop | the run's ending: summary, stopReason, spend, check, changes, todo | window (folds the trail), plugins |
| `run_stats` | loop | the one stats line `npm run stats` aggregates | stats, plugins |
| `cancelled` | harness | a stop arrived: `running` says whether there was a run | window, plugins |
| `job_start` | loop | a background command started: its id, kind and command | window (job row), plugins |
| `job_end` | loop | a background command finished: its id, exit code and stopped flag | window (job row), plugins |

## The send and the edge

| event | fired by | what it says | read by |
|---|---|---|---|
| `assistant_delta` | send | a text chunk streamed back | window (bubble) |
| `reasoning_delta` | send | a reasoning echo streamed back | window (folded thinking) |
| `firewall_note` | send/harness | the edge refused or the rewrite chain acted | window, CLI |
| `needs_tab` | send | no logged-in chat tab: the one-click fix names the URL | window (banner) |
| `tab_opened` | rpc | the tab a window offered to open is open | window (banner down) |

## Tools

| event | fired by | what it says | read by |
|---|---|---|---|
| `tool_start` | loop | a call is admitted for execution, in marker order, before its result | plugins, window |
| `tool` | loop | a call finished: kind, label, ok, head, sources | window (tool row), CLI |
| `plugin_call` | loop | a plugin marker was dispatched by name | window, plugins |
| `repeat_block` | loop | the repeat guard refused an identical call | window, plugins |

## Helpers

| event | fired by | what it says | read by |
|---|---|---|---|
| `subagent_start` | loop | a SUBAGENT began (foreground or background) | window, plugins |
| `subagent_end` | loop | a SUBAGENT finished, with its summary | window, plugins |
| `helper_start` | harness | a helper run starts (the fan-out's own session) | window, plugins |
| `helper_end` | harness | a helper run ended: summary, prepared, skipped | window, plugins |

## Guards

| event | fired by | what it says | read by |
|---|---|---|---|
| `stagnation` | loop | repeat/oscillation/circle detected: warn or stop | window, plugins |
| `verify_prompt` | loop | the R4 nudge: staged code nothing has checked | window, plugins |
| `budget` | budgets | a budget fired: which one and what it had spent | window, plugins |
| `check_start` | gates | the checker began: the files and the declared command | window, plugins |
| `check_end` | gates | the checker's verdict, and whether it ran | window, plugins |
| `lang_prompt` | gates | the closing message missed the Thai ratio: one rewrite asked | window, plugins |

## The tree and the context

| event | fired by | what it says | read by |
|---|---|---|---|
| `diff_update` | loop/harness | the staged changes now (file, added, removed, deleted) | window (diff panel) |
| `applied` | loop | an apply wrote its files (with the checkpoint id) | window, plugins |
| `discarded` | harness | pending changes dropped without writing: how many | window, plugins |
| `compacted` | loop/harness | summarise + rotate happened: the summary and the memory facts | window, plugins |
| `conversation` | harness/rpc | the conversation a session talks through (created, adopted, rotated) | window (header) |
| `session` | harness | the session a run writes to (id, title, file) | window (follows the run) |

## Mid-run messages (inject)

| event | fired by | what it says | read by |
|---|---|---|---|
| `inject_queued` | harness | a mid-run message entered the queue: how deep it is | window, plugins |
| `injected` | loop | the queue was drained into a step's paste: how many | window, plugins |
| `inject_orphaned` | harness | the run ended first: the texts go back to the composer | window, plugins |

## Gates to the person

| event | fired by | what it says | read by |
|---|---|---|---|
| `permission_request` | permissions | a call needs an answer (id, kind, preview, risk) | window (modal), CLI |
| `plan_request` | harness | a PLAN waits for approval in plan mode | window, CLI |

## The project goal

| event | fired by | what it says | read by |
|---|---|---|---|
| `goal_round` | loop | a plain DONE was refused while the goal is active: the round and the cap | window, plugins |
| `goal_done` | loop | GOAL DONE: the closing words the model gave | window, plugins |
| `goal_blocked` | loop | GOAL BLOCKED, or the round cap was reached: the reason | window, plugins |

## Notes and backend state

| event | fired by | what it says | read by |
|---|---|---|---|
| `note` | everywhere | a one-line fact worth a row in the transcript | window, CLI, plugins |
| `todo` | loop | the checklist's merged state | window (plan card) |
| `project` | rpc | the backend's current project moved | window (header) |
| `settings` | rpc | saved settings changed: the new values | window (re-renders) |
| `session_forked` | rpc | a session forked from another: both ids | window (sidebar) |
| `session_opened` | rpc | a session was opened: its id and header | window (sidebar) |
| `plugins` | plugins/rpc | the plugin table changed (loaded, failed) | window (plugins panel) |
