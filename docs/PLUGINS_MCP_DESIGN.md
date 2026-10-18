# Plugins & MCP — installation design

Design of record for **installing, enabling, updating and removing** the two
extension channels: local plugins (`~/.aipass/plugins`) and MCP servers
(`~/.aipass/mcp.json`). Written ahead of implementation; **today** marks what
already exists in code. Related reading: `SECURITY.md` (the trust model this
must not change silently), `docs/HARNESS_DESIGN.md` (the harness these extend),
`docs/UX.md` (surfaces and voice), `desktop/README.md` § Plugins.

## 1. Scope

**Designed here:** the lifecycle — where an extension comes from, how it is
inspected, installed, validated, enabled, updated and removed, and what the
user sees at each step, over the CLI, `/rpc` and the window.

**Not designed here:** the plugin `ctx` API (`harness/plugins.mjs` stays the
contract), MCP protocol breadth (resources, prompts, HTTP/SSE transport),
sandboxing (the trust statement is the answer — `SECURITY.md`), and a hosted
marketplace (a phase-3 sketch only).

## 2. Today

| Piece | State |
|---|---|
| Discovery | `~/.aipass/plugins/*.mjs` and `<dir>/plugin.mjs`; `PluginManager.load()` at backend boot, `plugins.reload` RPC. |
| Enable | `settings.plugins` — a name allowlist read **before** setup runs; empty = everything found. |
| Provenance | `plugins.list` reports per plugin `sha256`, `bytes`, `mtime`, `apiVersion` — recorded at load, not at install (there is no install). |
| Failure | A plugin that throws mid-setup is rolled back and listed in `failed[]`; it registers nothing. |
| Install surface | **None.** The settings sheet's ปลั๊กอิน section is read-only cards plus a reload button; no CLI. |
| MCP config | `~/.aipass/mcp.json` + `<root>/.aipass/mcp.json`, hand-edited, `{servers:[{name, command, args, env}]}`. |
| MCP runtime | Lazy once per harness (`ensureLoaded`), stdio only, tools exposed as `MCP__server__tool`. |
| MCP gating | **Tools run ungated.** `toolTable()` passes `risk: null`, and `classify('plugin')` is `'read'`, so an MCP filesystem server can write with no question in any mode. |
| MCP surface | `mcp.list` RPC (connected server names + tools), `/mcp` command, `aipass mcp list\|call`. No add/remove/test/reload, no enabled flag, no `cwd`, no per-server status. |
| Two known defects | `mcp.mjs` `loadConfig` de-dups keeping **home** first although its own comment says project overrides home; the stdio spawn omits `windowsHide: true` (AGENTS rule 10). |

## 3. Principles

1. **Install is the consent moment.** Plugins and MCP servers are trusted, not
   sandboxed — the user is about to run someone's code in the backend process.
   Every install surface shows what will run, from where, and what it can
   reach, then asks. Nothing installs itself.
2. **One module, three doors.** `harness/install.mjs` holds the logic. The RPC
   handlers and the CLI both call it; the window talks RPC. No surface gets a
   private code path, the way `rules.get/set` and `aipass agent` already share
   one policy file.
3. **Stage → validate → swap.** An install never removes a working copy to
   make room. Validation runs against a staged copy; a failure leaves the old
   version loaded and says why.
4. **Files are the API.** Everything an install writes is a file a person can
   read, copy or delete with Finder/Explorer. Deleting the registry can never
   break loading — it only loses the "where did this come from" answer.
5. **Provenance is information, not protection.** A recorded hash makes "did
   this change since it behaved?" answerable; it does not stop anything. The
   stops are the file system, the permission gate, and the person.

## 4. Layout and formats

```
~/.aipass/plugins/
  notes.mjs                  # hand-dropped, unmanaged — stays legal forever
  weather/                   # installed (managed)
    plugin.mjs
    package.json             # only when the source had one
    node_modules/            # only when dependencies were installed
  .registry.json             # provenance of what the installer put here
  .staging/                  # transient: download, validate, swap out of here
  .trash/                    # transient: the previous version, kept until next install
```

- `discover()` gains one rule: **skip entries starting with `.`.** `.staging`
  and `.trash` are then inert by construction, not by accident of depth, and
  `.registry.json` is doubly ignored.
- **`.registry.json`** (advisory; a missing or malformed file reads as `{}`):

```json
{
  "version": 1,
  "plugins": {
    "weather": {
      "source": { "type": "url", "ref": "https://example.com/weather.mjs" },
      "sha256": "e3b0c442…",
      "installedAt": "2026-10-18T09:00:00.000Z",
      "installedBy": "desktop-ui"
    }
  }
}
```

  A folder with a `plugin.mjs` that is **not** in the registry is *unmanaged*
  (hand-dropped). The installer never overwrites or deletes unmanaged work
  without an explicit, named confirmation.

- **`mcp.json` entry** (all new fields optional — an old file loads unchanged):

```json
{
  "servers": [{
    "name": "filesystem",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
    "env": { "LOG_LEVEL": "error" },
    "enabled": true,
    "risk": "write",
    "cwd": "."
  }]
}
```

  - `enabled` (default `true`) — a disabled server is not spawned, still listed.
  - `risk` (default `"write"`) — see §7.
  - `cwd` (default: inherit) — relative to the project root for project-scope.
  - **Dedup fix:** project overrides home, as the comment has always claimed.
  - The file is created `0o600` where the OS has modes, like the token file.

- **Plugins enabled list** (`settings.plugins`). Semantics made precise because
  the install surface starts writing it:
  - `[]` = master switch on: every plugin found now and later is enabled.
  - The **first** disable while the list is empty materializes it as the
    currently loaded names minus the disabled one.
  - `enable` adds the name back; if the resulting list covers every loaded
    name it **collapses to `[]`** — an explicit list that equals everything
    would silently turn *off* the next install.

## 5. The installer — `harness/install.mjs`

```
source ─▶ plan (pure) ─▶ inspect (read-only) ─▶ consent ─▶ stage ─▶ validate (import) ─▶ swap ─▶ registry ─▶ reload
                                                                        │ throws
                                                                        ▼
                                                              discard staging; nothing changed
```

| function | does | must not |
|---|---|---|
| `plan(source)` | source string → `{kind, ref, needs[]}` or a named refusal | touch the disk |
| `inspect(plan)` | bytes, size, `sha256`, entry shape; reports, never executes | import or run anything |
| `install({plan, expectedSha256, name?})` | stage → validate → swap → registry; returns the loaded plugin detail | execute before consent; destroy the previous version on failure |
| `remove(name, {force})` | managed → `.trash/<name>-<ts>`; unmanaged → refuse unless `force` | delete a path outside the plugins dir; follow a link out of it |

**Sources.**

| source form | kind | phase |
|---|---|---|
| `C:\path\notes.mjs` or `./folder/` (with `plugin.mjs`) | `path` | P1 |
| `https://…/plugin.mjs` (≤ 1 MB, `https` only) | `url` | P1 |
| `npm:<pkg>[@range]` — package root must ship `plugin.mjs` | `npm` | P2 |
| `git+https://…#<ref>` — repo root must ship `plugin.mjs` | `git` | P2 |

Refusals are named, not shrugged: `http://` (unless a literal loopback
host), a `..` in the resolved path, a single file over the cap, a name failing
`/^[a-z0-9][a-z0-9._-]*$/`, an `npm`/`git` source with that tool not on PATH
(the error names the tool and the alternative source kind).

**The one subtle rule:** validation *is* execution — `import()` runs top-level
code, which is also how `load()` has always worked. So consent sits **before**
staging the code into place, and the inspect step is built to know only
size and hash. The confirm step carries the trust sentence; the `setup()`
result appears after. A local folder source shows its total size up front so
"this includes node_modules" is visible, not discovered.

**Validation and swap.** Stage under `~/.aipass/plugins/.staging/<ts>-<name>/`
and load it with a real `PluginManager` pointed at the staging dir — the same
loader, the same rollback, so staging and production cannot drift. On success:
old folder → `.trash/`, staging → final name, reload the live manager. If the
real location turns out to fail (a path assumption staging shared but a later
edit broke), the trash copy is moved back and the failure is reported — the
working version survives both failure points.

**Update = install over.** `install` resolving to an existing managed name is
the update path: stage the new, validate, swap, keep the old in `.trash`.
There is no separate updater until P2 records the source well enough to
re-fetch it.

## 6. Plugins — RPC surface

| method | params | returns |
|---|---|---|
| `plugins.inspect` | `{source}` | `{kind, name?, size, sha256, hasPackageJson, files?}` or `{error}` |
| `plugins.install` | `{source, expectedSha256?, name?}` | the loaded detail, or `{error}` — never throws for a refused source |
| `plugins.remove` | `{name, force?}` | `{removed, trashed?}` |
| `plugins.enable` / `plugins.disable` | `{name}` | the new `settings.plugins` list |
| `plugins.reload` | — | **today:** `details()` |
| `plugins.list` | — | **today:** `details()` + per plugin `installed: {source, sha256, installedAt} \| null` and `hashChanged: bool` (loaded hash ≠ registry hash) |

`enable`/`disable` write through `settings.set`, so the existing live-reload
path (`void plugins.load()`) is the one that fires — no second mechanism.
`install`/`remove` end with `plugins.load()` and emit the existing `plugins`
event, so an open window's section can refresh from one subscription.

## 7. MCP — config and lifecycle

- **Risk, and the hole it closes.** MCP tools today carry `risk: null`, and
  `classify('plugin')` is `'read'` — every MCP call is pre-answered yes, in
  every mode. New mapping in `toolTable()`: server `risk` (default `"write"`)
  becomes the tool's declared risk, so a tool rides the same verdict a
  built-in of that kind would get in the current mode; `"read"` is the
  operator's explicit "this server is read-only, never ask" (an honest trust
  statement, like a path rule — not a verification). The value is per server,
  chosen at add time, editable, and shown on the server row.
- **`mcp.list` grows a status row per server**, keeping the flat `tools` array
  for the existing `/mcp` output:

```json
{ "servers": [
    { "name": "filesystem", "scope": "home", "enabled": true, "risk": "write",
      "connected": true, "error": null, "tools": 12,
      "toolMarkers": ["MCP__filesystem__read_file", "…"] }
  ],
  "tools": [ "…unchanged shape…" ] }
```

- **Lifecycle methods.** `mcp.add` (validates the name,
  `/^[a-z0-9][a-z0-9-]*$/` — no `__`, which the marker format reserves;
  writes home or project scope; reloads; returns the server's status row),
  `mcp.remove`, `mcp.enable` / `mcp.disable` (flips `enabled`, keeps the
  config — here the entry *is* the artifact), `mcp.reload` (close clients,
  clear `loaded`, `ensureLoaded()` again; the harness re-merges the tool table
  at each `run()` start, so the next run sees the new world), and `mcp.test`
  `{name}` or an ad-hoc `{command, args, env}` for the add form before saving:
  spawn, initialize, `tools/list`, 10 s cap, kill, report `{ok, tools, error,
  ms}`. A test is a run of the command — the add form says so.
- **Spawn hygiene** (a fix this change owns): `windowsHide: true` on the
  spawn, argv arrays only, never `shell: true`, `cwd` honoured. Closing a
  server kills it; a server that leaks children on Windows is a known-limit
  note unless it proves to matter (then the `taskkill /T` pattern the desktop
  shell already uses).
- **`env` is secret-class.** Values are never rendered back (the UI shows
  `KEY = •••••`), never logged (the bridge's scrub list cannot know arbitrary
  values, so the code must not put them in log lines), and the file they live
  in is owner-only when the installer creates it. Deleting a server deletes
  its env with it.

## 8. CLI

```
aipass plugin                        list (installed + hand-dropped, enabled state)
aipass plugin inspect <source>       size + sha256, no execution
aipass plugin install <source>       [--name x] [--yes] [--force]
aipass plugin remove <name>          [--force]   (unmanaged needs --force)
aipass plugin enable|disable <name>
aipass mcp                           list with status dots (today: tools only)
aipass mcp add <name> [--scope home|project] [--risk write|read]
             [--env K=V]… [-C dir] -- <command> [args…]
aipass mcp test|remove|enable|disable <name>
aipass mcp call <marker> [json] — unchanged
```

**One writer at a time:** when the desktop backend is reachable (loopback +
token from `~/.aipass/.token`), the CLI *is* a client and calls the RPC — the
running window updates live and in-memory state cannot go stale. With no
backend up, the CLI writes the same files directly; the next backend start
reads them. `--yes` exists so scripts can install without the interactive
confirm, and it prints the trust sentence either way. `aipass doctor` gains
one line: plugins that failed to load, MCP servers that failed to connect.

## 9. The window

Two settings sections, matching the sheet's existing shape:

**ปลั๊กอิน** — installed cards gain a state line (`ที่มา: npm:… / URL / ไฟล์วาง
เอง`, hash 8 chars), a toggle (เปิด/ปิด), and ลบ behind a destructive confirm.
An install box takes a path or URL: `[ตรวจสอบ]` → a preview card (kind, size,
sha256, `"ติดตั้งเฉพาะโค้ดที่คุณอ่านแล้ว — ปลั๊กอินรันด้วยสิทธิ์เดียวกับตัวแอป
(เขียนไฟล์และรันคำสั่งได้)"`) → `[ติดตั้ง]`. Failure renders as the existing
`failed` card shape with the error text. Install implies enable: a non-empty
allowlist gains the name.

**MCP** (new, 🔌) — server rows with a status dot (green connected / red error
+ reason / grey ปิด), tool count, risk word, and `[ทดสอบ] [ปิด|เปิด] [ลบ]`. The
add form: name, command, args (one per line), env (`KEY=VALUE`, values shown
while typing, masked after save), scope (ทุกโปรเจกต์ / เฉพาะโปรเจกต์นี้), risk
(`เขียน — ถามตามโหมด` default / `อ่าน — ไม่ถาม`), `[ทดสอบ]` runs the command
once and lists the tools it offers, `[บันทึก]` writes and connects. The empty
state points at `[เพิ่มเซิร์ฟเวอร์]`, never at "go edit mcp.json".

`/mcp` keeps listing and gains one line pointing at `/settings` → MCP. No
chat-side arg parsing; the sheet is the one form.

## 10. What security owes this change

- `SECURITY.md` gains its bullet in the same change (MATURITY already claims
  it exists): plugins and MCP servers are **trusted, not sandboxed** — install
  surfaces, the consent sentence, the hash record as provenance-not-
  protection, MCP tools defaulting to the write gate, and `mcp.json` env
  values as secrets-class data.
- The registry and `mcp.json` writes use the settings module's atomic pattern
  (temp + rename); created files get owner-only modes.
- Nothing in the install path silently re-enables a previously disabled
  extension, and removing never follows a link out of the plugins directory.

## 11. Tests and docs

Proposed test titles (the `Verify:` anchors, per the repo's rule format):

- `test/install.test.mjs` (new) — *"an install stages, validates, then swaps —
  a plugin that throws in setup leaves the old version live"* · *"inspect
  knows only size and hash, and runs nothing"* · *"plan refuses http://, a
  traversing path, and a name that would leave the plugins directory"* · *"a
  stale hash between inspect and install refuses the swap"* · *"deleting the
  registry never blocks loading — provenance is not a gate"*.
- `test/plugins.test.mjs` (extend) — *"disabling one plugin materializes the
  list; enabling it back collapses the master switch"* · *"remove refuses an
  unmanaged file, and a managed one moves to trash"*.
- `test/mcp.test.mjs` (new) — *"a project mcp.json overrides a home server
  with the same name"* · *"an MCP tool rides the write gate by default; a
  server declared read does not ask"* · *"mcp.reload drops the old clients and
  reconnects; a failed server stays listed with its error"* · *"adding a
  server writes the file owner-only and never logs env values"*.
- `test/desktop-window.test.mjs` (extend) — *"the install box inspects, warns,
  and only then installs"* · *"the MCP section masks env values and shows a
  status row per server"*.

Docs updated in the same change: `SECURITY.md`, `desktop/README.md` § Plugins
(+ a MCP section), `docs/MATURITY.md` rows (plugins, MCP — evidence and
status), `CHANGELOG.md` `[Unreleased]`.

## 12. Phases

- **P1 — the spine.** Layout + registry; `install.mjs` with `path` and `url`
  sources; plugins RPC + CLI + settings-section actions; MCP config fields
  (`enabled`, `risk`, `cwd`), dedup fix, `windowsHide`, lifecycle RPC + CLI,
  MCP settings section; the tests above.
- **P2 — sources and upkeep.** `npm:` and `git+` sources (dependencies via
  `npm install`, default `--ignore-scripts` with a named opt-out, because an
  install script would run code the user has not chosen to load yet); update =
  install over the recorded source; trash pruning (last copy per name);
  `aipass doctor` line.
- **P3 — named, not designed here.** A curated index (JSON: name, version,
  url, sha256, apiVersion) and `aipass plugin search`; MCP HTTP/SSE transport;
  resources and prompts; signed artifacts.

## 13. Open questions

1. `npm:` / `git+` in P1 or P2? This design assumes P2 — the spine and the
   surfaces are the expensive part, sources are additive.
2. MCP default `risk: "write"` — accept, or ask once per server at add time?
   (This design defaults to write and keeps the add form as the place to say
   otherwise.)
3. Should the CLI poke a running desktop backend (best-effort RPC) after a
   file-level operation? This design says yes; the alternative is "restart or
   press reload".
4. Trash policy: one previous version per name (this design) or timestamped
   history with a cap?
