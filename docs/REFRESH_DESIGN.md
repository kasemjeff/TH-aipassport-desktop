# REFRESH_DESIGN.md — the model catalog's refresh system

> The design of record for the model list: where it comes from, when it is
> fetched, when the window is told, and why pressing Ctrl+R is not the answer
> any more.
>
> Line numbers drift — the checkout is shared and sessions run in parallel.
> Match on the names.

## The complaint

> "Sometimes the model does not come up. I have to sit there pressing Ctrl+R
> all the time."

The model dropdown shows the two-model stub, or nothing, and the only way to
get the real catalog is to reload the whole window.

## What actually happens today

### Where the list comes from

The live catalog is **not** fetched by the app. It is fetched by the Chrome
extension, in the page, from `de.aipass.net`:

```
window #model  ──rpc('models')──►  harness/rpc.mjs  ──GET /v1/models──►  bridge/server.mjs
                                                                              │
                                                                    listModels({force})
                                                                              │
                                              fetchLoader(LOADERS.models) ──► extension ──► de.aipass.net
```

Three facts follow from that shape, and every one of them is a reason the list
does not show up:

1. **No extension, no catalog.** `listModels()` in `bridge/server.mjs` asks
   `extClients.size`; with no attached extension it never fetches and returns
   `cachedModels()` — which is `MODELS_FALLBACK`, two ids
   (`gemini-3.1-flash-lite,claude-sonnet-5@default`, overridable with
   `AIPASS_MODELS`). `/v1/models` labels that answer `source: 'fallback'`.
2. **The cache has a TTL and a single-flight.** `MODEL_TTL_MS` is 60 s, and
   one fetch at a time (`modelRefresh`); a second caller joins the one in
   flight. `force` skips the TTL — nothing else does.
3. **The window's call always forces.** `harness/rpc.mjs` `models()` calls
   `bridge.models(true)` — hardcoded. Every read of the list is a real fetch
   against the tab.

### Why the window stops asking

`fillModels(currentModel)` in `desktop/ui/app.js` is the only thing that fills
the dropdown, and it is called from three places: the provider `<select>`'s
`onchange`, `setProvider()` (the `/provider` command), and `refreshHeader()`
— the last one under this guard:

```js
if (st.model && !$('model').options.length) await fillModels(st.model);
```

`options.length` is 2 the moment the stub is in. **The guard then never fires
again for the life of the window.** The list is decided once, at boot, and
frozen — even after the extension attaches ten seconds later, even after the
user logs into the tab. The only remaining ways to re-fill are a provider
switch or a page reload.

### Why the failure is invisible

`source` is read in exactly one place: the "the site dropped this model"
marking, which only fires when `source === 'live'`. The `fallback` case is
never surfaced. The reader sees a two-item dropdown and no sentence explaining
it, so the only available move is to reload and hope.

### Why Ctrl+R is the only escape

`app.js` binds no `ctrl+r`. The key falls through to the Tauri webview's
default reload, which re-runs boot — and boot calls `fillModels`. So a page
reload works, and it is the only thing that works, and it costs the reader
their scrollback, their focus and their half-typed prompt.

### The hole in the bridge's own warm-up

`extEvents()` warms the caches 500 ms after the extension attaches — but only
**once per process** (`warmLoaded`). The extension's SSE cycles every few
minutes and the tab is closed and reopened; the second attach logs "extension
connected" and warms nothing. If the first warm landed before the page was
logged in, the catalog stays a stub until something forces it.

## The design

### 1. The bridge publishes what it knows

The window cannot tell a stub from a catalog without triggering a fetch, and
that is the whole problem: **observation and refresh are the same call today.**
Separate them.

`bridge/server.mjs` keeps the outcome of the last attempt:

```js
let modelState = { source: 'fallback', at: 0, count: 0, error: null };
```

- `source` — `'live'` (a real catalog), `'fallback'` (the stub, no extension),
  `'none'` (nothing at all)
- `at` — when the list was last built; **the window watches this stamp**
- `error` — the message of the last failed fetch. Today it is logged
  (`model refresh failed:`) and then lost, which is why the window cannot say
  what went wrong.
- `count` — how many models the list holds

`/status` gains `catalog: modelState`. The name is not `models`: the bridge's
`/status` already carries `models: cachedModels()` — the list itself — and two
things called `models` would be a trap.

The harness's `status()` in `harness/rpc.mjs` builds its own object out of the
bridge's answer (it copies `extensions`, `extensionToken`, `cache` and the
rest field by field), so the new field is copied through there too:
`catalog: st?.catalog ?? null`.

The status call the window already makes every ten seconds now carries the
truth about the catalog, for free.

### 2. The bridge heals its own stub

**The one-shot warm stays.** The warm-up at attach time is deliberately once
per process: the tab's SSE cycles every few minutes, and four upstream
fetches on every cycle bought nothing the caches' own TTLs do not already
cover. Warming on every attach instead would put that cost back.

**But the warm can fail, and nothing retried it.** It fires 500 ms after the
tab attaches, and a tab that is attached is not necessarily a tab that is
logged in — so the warm can land before the page can answer. The catalog then
stays a stub until something forced it, which was the reader's job and should
not have been.

So the bridge **retries its own stub**: every `MODEL_RETRY_MS` (30 s), only
while `extClients.size > 0`, and only while the catalog is still a stub. Once a
real catalog lands, the timer stops itself and the ordinary 60 s TTL takes
over. The tab is not poked forever — the retry exists only in the state where
there is nothing to show.

This is the part that removes the need for the reader to do anything: the
bridge heals the stub by itself, and the window learns about it through the
`/status` stamp.

### 3. The harness stops forcing

```js
// harness/rpc/core.mjs
async models(params = {}) { return targetFor(params).bridge.models(params.force === true); },
```

`force` becomes the caller's business: the refresh button wants a real fetch,
a poll wants the cache. This mirrors `credits()`, which already takes
`force` and which the window already calls as
`rpc('credits', { force: Boolean(state.running) })` so an idle window does not
poke the tab every ten seconds.

`harness/provider-client.mjs` `models()` takes no argument, so the extra
`force` is harmless there; a non-AiPASS provider's list carries
`source: 'live' | 'spec' | 'none'` and the window reads all three.

### 4. The window owns a small state machine

```js
const modelState = {
  source: 'unknown',   // 'live' | 'fallback' | 'spec' | 'none' | 'unknown'
  at: 0,               // the stamp of the list on screen
  error: null,         // why the last refresh failed
  loading: false,
  promise: null,       // the in-flight refresh, so a poll and a click join one
};
```

`refreshModels({ force })` replaces the fire-and-forget `fillModels()`:

- **One at a time.** A refresh already in flight is joined, not duplicated.
- **A failed refresh never takes the list away.** The options stay; the chip
  says what failed. An empty dropdown after a failed refresh is worse than a
  stale one.
- **The rebuild preserves the selection.** `fillModels()` restores the *model
  in use*; a refresh must restore *what the reader had picked*, and fall back
  to the model in use only when that one is gone. Otherwise a poll that lands
  mid-choice yanks the dropdown out from under the reader.
- The "the site dropped this model" marking is kept exactly as it is.

### 5. Three triggers, one rebuild

**A. The poll — free, and the one that actually fixes it.**
`refreshHeader()` already calls `rpc('status')` every ten seconds. Once
`status` carries `catalog.at`, the window compares that stamp with the one it
rendered and rebuilds the dropdown **only when the catalog changed**. No extra
request, no upstream fetch, and the list appears by itself once the bridge
heals the stub.

**B. The button.**
A small control beside `#model` in the composer row. `force: true`. It shows a
spinner while it runs and is disabled while it runs. This is the "I want it
now" move, and it costs one fetch.

**C. Ctrl+R inside the model picker.**
While the model picker is open, Ctrl+R refreshes the list in place and keeps
the picker open.

**The global Ctrl+R stays a page reload — deliberately.** A wedged page needs
its escape hatch, and hijacking a universal shortcut to mean something else is
a bad trade. The reason the reader was reaching for Ctrl+R is going away; the
shortcut does not have to change meaning to achieve that.

### 6. The list says what it is

The chip next to `#model` carries the truth:

| source      | the chip says              | the title says                                  |
| ----------- | -------------------------- | ----------------------------------------------- |
| `live`      | nothing                    | —                                               |
| `fallback`  | "สำรอง (2)"                | the catalog is the two-id stub; no tab is attached |
| `spec`      | "จากสเปก"                 | the provider has no live catalog; this is its spec list |
| `none`      | "ไม่มีรายการ"              | the provider answered with no models            |
| error set   | the reason                 | the last refresh failed, and why               |

And a **banner** — the same shape as `syncExtensionToken()`'s: one banner, not
one per poll, with a one-click fix:

> รายชื่อโมเดลยังไม่ได้มาจากเว็บ — [เปิดให้] (เปิดหน้า de.aipass.net แล้วกดรีเฟรช)

This is the highest-value single change in the design. Today the reader sees
two models and no explanation; afterwards the same reader sees two models and
a sentence with a fix in it.

## What this deliberately does not do

- **No hijack of the global Ctrl+R.** The poll and the button are the answer.
- **No ten-second forced polling.** The window polls `/status` (cheap, local)
  and only the *bridge* goes upstream, and only when it has a reason.
- **No blank dropdown on failure.** A stale list is worth more than no list.
- **No new dependency, no new build step, no new transport.** The refresh
  rides the `rpc` method that is already there.

## The files

| file                       | what changes                                            |
| -------------------------- | ------------------------------------------------------- |
| `aipass-bridge/bridge/server.mjs` | `modelState`; `/status` carries it as `catalog`; the stub retry; `/v1/models` carries the stamp and the error |
| `aipass-bridge/harness/rpc/core.mjs` | `models()` takes `force`; `status()` copies `catalog` through |
| `desktop/ui/app.js`        | `modelState`; `loadModels()`; the chip; the banner; the poll; the picker's Ctrl+R |
| `desktop/ui/commands.js`   | the picker asks the site and says it is open          |
| `desktop/ui/state.js`      | `modelPicker` — whether the picker is the sheet on screen |
| `desktop/ui/index.html`    | the refresh control and the marker beside `#model`     |
| `desktop/ui/styles.css`    | the control's look, the marker's look                  |
| `aipass-bridge/test/bridge.test.mjs` | the bridge's half              |
| `aipass-bridge/test/desktop.test.mjs` | the harness's half           |
| `aipass-bridge/test/ui.test.mjs`     | the window's half               |

`aipass-bridge/bridge/server.mjs` is under the same rule as everything else
here: `aipass-bridge/AGENTS.md` is the local law. `desktop/AGENTS.md` is the
window's law — "errors surface as banners with a one-click fix where one
exists" is the line the banner answers to.

## The tests

Each title below is the `Verify:` anchor a rule in `AGENTS.md` carries.

- "the bridge publishes the catalog's source, its stamp and its last error"
- "a fallback catalog is retried while an extension is attached"
- "asking for the models does not force a fetch unless the caller says so"
- "the window rebuilds the model list when the bridge says the catalog changed"
- "a manual refresh asks the bridge for a fresh catalog"
- "a failed model refresh keeps the list it already had"
- "a fallback list says why it is a fallback"
- "a refresh keeps the choice the reader had made"

## The order of the work

1. **The bridge tells the truth.** `modelState` + `/status`. Nothing else can
   be built before this, and it is the smallest change.
2. **The harness stops forcing.** `models({force})`.
3. **The window watches the stamp.** The poll rebuilds the dropdown when the
   catalog changed. *This alone removes the need for Ctrl+R.*
4. **The bridge heals the stub.** The retry, armed on every attach. The window
   picks it up by itself.
5. **The window says what it is.** The chip marker + the banner.
6. **The button and the picker's Ctrl+R.** The manual path.

Steps 1–3 make the list appear on its own. Steps 4–6 make it explain itself
and give the reader a handle.

## Risks

- **The retry pokes the tab.** Bounded: 30 s, only while the catalog is a
  stub, only while an extension is attached, and it stops the moment a real
  catalog lands. The existing "idle windows ride the cache" law
  (`credits({force: false})` while idle) is kept.
- **The status payload grows.** Four fields. The window reads them from a
  call it already makes.
- **Two sessions, one checkout.** The bridge and the window are shared
  surfaces. Every hunk here has to be re-checked against the file as it is
  when the edit is made; the design names functions, not
  line numbers, for that reason.
- **Not addressed here.** `harness/rpc.mjs` `models()` always goes to the
  AiPASS bridge client, even for an added provider whose list lives in its
  own spec. That is a separate bug and this design does not fix it.
