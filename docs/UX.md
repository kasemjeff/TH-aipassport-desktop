# UX design — aipass

Design notes for the user-facing surfaces: the CLI, the desktop window, the
extension popup, and first-run setup. Written ahead of implementation
("design first"); the first implementation pass (P0+P1, and P2 where feasible)
has since shipped — see **§7 Status** for what landed and what remains. Each
section names what exists today, the pain, and the proposed change with a
priority.

The project's voice for UX: **quiet, direct, one primary action per state.**
Thai-first where the user reads Thai, English where the model reads. No
modal dialogs that block the whole window unless the decision is destructive.
Every failure names the single next action.

---

## 1. Principles

1. **One primary action per state.** A screen in an error state offers exactly
   one button: the thing that fixes it. Secondary actions (refresh, advanced)
   are links, not buttons.
2. **No dead ends.** Every error message ends with a concrete next step and,
   where possible, a button that performs it.
3. **Progressive disclosure.** The happy path is one command / one click.
   Advanced settings (token, CORS, rules) live behind "Advanced" and never
   appear on the first screen.
4. **Status is ambient, not modal.** Connection state, context %, credits
   live in the header/footer and update live; they never interrupt a run.
5. **Recovery is automatic where safe.** A dropped stream reattaches; a
   running bridge is adopted; a missing token is minted. Only irreversible
   actions (writing files, spending credits) ask.
6. **Thai where the person reads, English where the model reads.** Markers,
   tool names, and protocol stay English; prose, labels, and errors are Thai.

---

## 2. Surfaces

| Surface | Entry | Audience | State today |
|---|---|---|---|
| CLI TUI | `aipass` | terminal users | streaming markdown, slash palette, good |
| CLI one-shot | `aipass "q"` | scripts | works |
| File agent | `aipass agent` | devs | dry-run default, good |
| Desktop window | `aipass desktop` | daily driver | rich: sessions, diffs, plan, context % |
| Extension popup | Chrome toolbar | setup/monitor | status + advanced token paste |
| Setup | `aipass setup` (new) | first run | checks, mints, opens pages |
| Doctor | `aipass doctor` | diagnostics | walks the chain, names next action |

---

## 3. Pain points (ranked)

### P0 — blocks a new user from succeeding

**P0.1 Token paste is manual and fragile.**
- Today: `aipass setup` copies the token to the clipboard, but the user must
  open the popup → Advanced → paste → save. If the clipboard is lost (another
  copy, a browser restart) the step fails silently and the popup says "bridge
  needs a token" with no recovery hint beyond "paste from ~/.aipass/.token".
- Proposed: popup gains a **"Paste from clipboard"** button and a
  **"Test connection"** button. On save, the popup polls `/status` for 5s and
  shows "connected ✓" or the exact failure. `aipass setup` prints the token as
  a short code (first 8 chars + "…" + length) so the user can sanity-check
  what they pasted.

**P0.2 "No tab attached" has no in-app recovery.**
- Today: popup shows "0 connected" and the hint "open de.aipass.net/chat". The
  desktop app shows a cryptic bridge error. `aipass` exits early.
- Proposed: popup's primary button becomes **"Open chat tab"** (opens
  de.aipass.net/chat in a new tab). Desktop shows a banner: "ไม่มีแท็บที่เชื่อม
  อยู่ — [เปิดแท็บ]" that clears itself when `/status` reports an extension.
  CLI prints the same and offers `aipass open-tab`.

**P0.3 Extension load is still fully manual.**
- Today: `chrome://extensions` → Developer mode → Load unpacked → select folder.
  Cannot be automated (Chrome security).
- Proposed: `aipass setup` prints a copy-pasteable folder path and, on
  Windows/macOS, tries to open `chrome://extensions` (best effort, already
  done). Add a **"Copy path"** button in the popup's Advanced section and a
  troubleshooting line: "ถ้า Load unpacked ไม่ขึ้น ให้ตรวจว่าโฟลเดอร์มี
  manifest.json".

### P1 — daily friction

**P1.1 Discoverability of new capabilities.**
- Symbols, MCP, memory, scale, background helpers, setup are CLI/agent features
  with no UI. The desktop slash palette and settings sheet do not mention them.
- Proposed: add slash commands `/symbols`, `/memory`, `/mcp` to the desktop
  palette; add a "Capabilities" subsection in settings showing what is on and
  the command to use it; `aipass --help` already lists them (done).

**P1.2 Memory is invisible.**
- Today: facts are carried silently; the user cannot see what the model
  "remembers".
- Proposed: a **Memory panel** in the desktop sidebar (under playbooks) listing
  persisted facts with a "forget all" button; `aipass memory` already lists
  them in the terminal. Show a small badge "N facts" in the header when > 0.

**P1.3 Context % is a number, not a story.**
- Today: "40%" with no explanation.
- Proposed: tooltip: "ใช้แล้ว 40% ของงบประมาณ — จะ rotate ที่ 40%"; on
  rotation, a one-line note in the transcript (already emitted as `note`)
  becomes a collapsible "carried forward: …" block.

**P1.4 Hardcoded user card.**
- Today: sidebar footer shows "Kasem / kasem@localhost" — a placeholder.
- Proposed: remove the card or populate it from `~/.aipass/settings.json`
  (`user.name`). Default to nothing (just the avatar dot) until set.

**P1.5 Theme toggle affordance.**
- Today: moon icon flips theme; choice is written through. Good, but the icon
  does not indicate the *current* theme at a glance.
- Proposed: the icon shows the theme that is on now (moon when dark, sun when
  light), and the button names that theme in Thai — `aria-label="ธีม: มืด"` —
  so the state is announced, not only drawn. The tooltip says what pressing it
  does.

### P2 — polish

**P2.1 Empty states.**
- Sessions list, files list, playbooks list show nothing when empty. Add a
  one-line hint + the action that fills them ("ยังไม่มีแชท — กด แชทใหม่").

**P2.2 Long-running feedback.**
- `aipass setup` and `aipass doctor` print progress; the desktop's "checking…"
  hero could show a spinner and the step name.

**P2.3 Keyboard-only parity.**
- Every action reachable by mouse should be reachable by keyboard; the palette
  already covers most. Audit remaining mouse-only controls (apply/discard
  buttons, per-file checkboxes).

**P2.4 Error copy.**
- Errors are terse and technical ("err: …"). Keep the `err:` prefix for the
  loop, but the window/CLI should translate the common ones to Thai with the
  next action.

---

## 4. Proposed implementation order

1. **P0.1 + P0.2** (popup recovery + desktop banner) — highest leverage,
   touches `popup.js`/`popup.html` and `desktop/ui/app.js`. No security change.
2. **P1.1 + P1.2** (slash commands for new features + Memory panel) —
   discoverability.
3. **P1.4** (remove/fix user card) — one-line.
4. **P1.3 + P1.5** (context tooltip, theme icon) — polish.
5. **P2.x** — as time permits.

P0.3 (extension load) cannot be automated; improve copy only.

## 5. Open questions

- Should the popup auto-fetch the token from the bridge? Security trade-off
  (any extension with host_permissions could read it). Recommend **no** — keep
  manual paste, but make it one-click via clipboard + clear verification.
- Should cross-session memory be on by default? Recommend **yes**, with
  `aipass memory clear` and a per-project store (already designed).
- Should MCP tools appear in the slash palette? Recommend **no** (they are
  agent markers, not window commands); list them in `/help` and settings.

---

## 6. Not in scope

- Rewriting the visual design system (colors, typography) — the current
  theme is coherent and tested.
- Mobile / web (no mobile client exists).
- i18n beyond Thai/English (the codebase supports `replyLanguage` th/en).

---

## 7. Status (2026-10-18)

What the first pass shipped, by the numbering above:

| Item | Status | Where |
|---|---|---|
| P0.1 token paste | shipped — "Paste from clipboard" + "Test connection" in the popup's Advanced section | `extension/popup.{html,js}` |
| P0.1 token paste (the window's half) | shipped — the bridge reports a refused extension in `/status`, so the window names the token instead of guessing "no extension", and one click puts that token on the clipboard: the paste is the only step left | `bridge/server.mjs`, `harness/rpc.mjs`, `desktop/ui/app.js` |
| P0.2 no-tab recovery | already existed — popup action button, desktop welcome rows with "เปิดให้", `aipass doctor` | `popup.js`, `ui/app.js`, `doctor.mjs` |
| P0.3 extension load | copy only — `aipass setup` prints the folder path and opens `chrome://extensions`; a "Copy path" button is **not possible** (Chrome exposes no filesystem path to the popup) | `setup.mjs` |
| P1.1 discoverability | shipped — `/memory`, `/mcp`, `/symbols` in the desktop palette; `aipass --help` lists all commands | `ui/app.js` |
| P1.2 memory visible | shipped — 🧠 panel in the sidebar (facts + "ลืมทั้งหมด"), backed by `memory.list` / `memory.clear` RPC | `ui/{index.html,app.js}`, `harness/rpc.mjs` |
| P1.3 context story | already existed — live tooltip with used/budget/reserve + the rotation card in the transcript | `ui/app.js` |
| P1.4 user card | shipped — hardcoded placeholder removed (populate from settings later if wanted) | `ui/index.html` |
| P1.5 theme icon | shipped — the icon shows the theme that is on now, and the button names it in Thai (`aria-label="ธีม: มืด"`) so the state is announced, not only drawn | `ui/{index.html,app.js}` |
| P2.1 empty states | mostly existed — welcome card; memory list gained its empty hint | `ui/app.js` |
| P2.2 long-running feedback | shipped (small) — the composer hint's dot pulses while a run is in flight | `ui/{styles.css,app.js}` |
| P2.3 keyboard parity | shipped — sessions/skills/files rows are Enter/Space operable (`clickable` helper) | `ui/app.js` |
| P2.4 error copy | shipped (first set) — the window translates the six most common loop failures to Thai with the next action (`friendly`); unlisted errors pass through verbatim | `ui/app.js` |

Open questions above are settled as recommended (no auto-fetch token, memory
on by default, MCP tools not in the palette). Remaining polish, if ever
wanted: widen the error map as new failures show up in the field, and audit
any control added after this date against P2.3.
