# RAG - retrieval that fits this harness

> **Status: Phase 1 built (lexical), Phase 2 built (RECALL on the shared tokenizer and searches facts), hardening pass 1 done, Phase 3 not started.**
> This file is the checked state of the current search/memory surfaces and the
> plan for the retrieval layer. Phase 1 and 2 are shipped; the remaining gaps
> (a shared scorer, prebuild/progress UI, embeddings) are tracked in the phases table.
>
> **One line:** index the project's own text locally, rank passages with BM25
> and code-aware chunks, and let the model ask for them with one marker. No new
> dependency, no network, no second memory. Embeddings are a gated second stage,
> not the first move.

## Why this exists

The harness already has three ways to find things: `SEARCH` (literal grep over
the project), `RECALL` (word match over past sessions), and the cross-session
memory facts carried on the first turn. None of them is retrieval:

- `SEARCH` is exact text. A person who asks "where do we renew the login token"
  has to guess that the code says `refreshToken`, and Thai text has no spaces to
  split into words.
- `RECALL` reads the newest 30 sessions and 128 KB of each, then scores an entry
  by how many query words it contains. There is no IDF, no phrase order beyond
  one bonus, and a Thai phrase arrives as one long token.
- The memory facts are carried into the first message but are not searchable
  afterwards: `RECALL` reads session entries, not the memory file, and a fact
  whose session has rotated away is only reachable if the first-turn carry
  happened to pick it.
- An attached document is sent whole as a base64 part. That is fine for one
  file, but there is no persistent corpus, no chunking, and no citation back to
  a page or a line.

The cost is paid by the model: it reads files to find out what it should have
retrieved, or it answers from the part of the project that happened to fit in
context.

## What "RAG" means in this repo

Retrieval-augmented generation is three steps: find passages, put the useful
ones in the model's context, and cite where they came from. In a chat app the
middle step is usually hidden. Here it should be a tool:

1. the retriever does the ranking (cheap, local, deterministic);
2. the model decides whether to ask, what to ask, and whether the passages
   answer the question;
3. every passage carries `path:start-end`, so the answer can be checked.

This is **agentic RAG**. It fits the existing marker protocol, the one-message
upstream constraint, and the rule that a run's context is paid for by the
person. It also means a bad query is the model's next query, not a silent
pre-step the user cannot see.

**Why not inject context on every turn by default.** Auto-injection spends
tokens on every message, including "fix this typo", and a wrong passage in the
first message is harder for the model to ignore than a tool result it asked
for. An optional first-turn prefetch is a later experiment (Phase 3), not the
default.

## What exists today (checked 2026-10-29)

| surface | what it does | the limit that hurts |
|---|---|---|
| `SEARCH` (`harness/tools.mjs#search`) | literal substring over project text, optional `-i`, `-A/-B/-C` context | case-sensitive by default (`searchI: false`); no ranking; first 50 matching lines in walk order win; skips every dotfile; 1 MB per file |
| `RETRIEVE` (`harness/retrieval.mjs`) | BM25 over chunked project text, staged edits folded in, 5 s index TTL | lexical only: a paraphrase with no shared word is a miss (measured in the benchmark) |
| `RECALL` (`harness/memory-store.mjs#recallEntries`) | BM25 over the shared tokenizer; session entries plus memory facts | 30 newest sessions, 128 KB tail each, 8 hits; its own scorer loop, not yet the `RETRIEVE` code |
| memory carry (`memory-store.mjs#carryFacts`) | picks facts for the first message under 2,400 chars | only the first turn; word match; facts not reachable from `RECALL` |
| `SYMBOLS`/`DEF`/`REFS` (`harness/symbols.mjs`) | regex symbol index cached under `~/.aipass/symbols` | finds names, not meaning; full synchronous walk and read on refresh (a rule 9 risk) |
| `ATTACH` (`harness/tools.mjs#attach`) | queues an image/PDF/office file for the next message | whole file, 20 MB cap, per-message only, no text extraction or citation |
| window file search (`desktop/ui/panels/files.js`) | name or literal content search over the project | a UI convenience, not a model tool; same exact-text limit |
| project file index (`harness/rpc.mjs#fileIndex`) | path list cached for 60 s for the picker | paths only; no content |

The existing tests pass (`node --test aipass-bridge/test/recall.test.mjs`: 5/5
on 2026-10-29), so this is a design gap, not a broken feature. Node 24's
`Intl.Segmenter('th')` does split Thai words, but transliterations are already
imperfect: `โปรเจกต์` segments as `โปร | เจ | กต์`. That is why the tokenizer
below adds character trigrams for Thai runs instead of trusting the segmenter
alone.

## Decisions

**D1 - Local lexical first.** BM25 over chunks is the default. It is
deterministic, offline, zero-dependency, and good at code identifiers. It is not
semantic; an embedding path is designed (Phase 3) but not built until a
benchmark shows the lexical miss rate is worth the privacy and cost.

**D2 - One tokenizer, one scoring shape.** Project files, sessions, and memory
facts use the same tokenizer and the same BM25 shape. `RECALL` still carries its
own loop over that tokenizer (a P1 gap), but tokenization must not drift.

**D3 - A tool, not a hidden pre-step.** `RETRIEVE <query>` is the model's
surface. The human surface is `/index` (status and clear) and one settings row.

**D4 - The index is a cache, not a source of truth.** Deleting it loses
nothing; the project is re-read. It never writes to the project, never follows
a link out of the root, and never stores a path that the secret floor would
refuse.

**D5 - No new dependency, no new service.** Node built-ins only (`Intl`,
`crypto`, `fs`, `zlib` if needed). The vector path, if it is ever turned on,
uses the provider the user already configured; the default is still local.

**D6 - No LLM reranker in v1.** Reordering 20 passages with a chat call spends
the person's credits to do a job a 20-line MMR selection does adequately. The
model can read the top 8 and ask again.

## The shape

```
project text ──> chunker ──> ~/.aipass/retrieval/<hash>.json
                                      │
task ──> RETRIEVE query ──> tokenizer ──> BM25 + boosts ──> MMR ──> 6 passages
                                      │                              │
                                      └── stats (files, age) ────────┤
                                                                     v
                                              model context: "path:start-end + excerpt"
sessions + facts ──> same tokenizer/scorer ──> RECALL (same output shape)
```

## Corpus

**Phase 1 - project text.** The same tree the tools already walk:

- include: source code, Markdown, plain text, CSV/JSON/YAML/TOML, HTML/CSS,
  `AGENTS.md`, `README`, `docs/**`, skills inside the project;
- skip: `SKIP` directories (`node_modules`, `.git`, `.aipass`, `dist`, `build`,
  `coverage`, `.next`, `target`, `vendor`), `.gitignore` hits, every dotfile and
  dot-directory (same rule as `SEARCH`), secret names (`secretHit`), lockfiles
  and minified/generated files (`package-lock.json`, `pnpm-lock.yaml`,
  `yarn.lock`, `*.min.js`, `*.map`), symbolic links that escape the root;
- binary: a NUL byte means "not text"; skip it;
- caps: 512 KB per file, 5,000 files, 20,000 chunks. A capped index says so in
  the answer; it never silently pretends to be complete.

**Phase 2 - sessions and facts.** `RECALL` moves onto the shared tokenizer and
scorer. Session entries keep their current `SPOKEN` filter (user/task/assistant/
note/compaction; a tool result is not talk). Memory facts are added as documents
with `kind: "fact"`, so a fact whose session rotated away is still reachable.
The 30-session/128 KB caps stay for v1; the answer already names how many
sessions it searched.

**Phase 3 - a document library (only if asked).** Uploaded files become a
persistent corpus under the app's own store, with a source list and a remove
button. PDFs stay attachments in Phase 1-2: extracting PDF text without a
dependency is a project of its own, and the provider already reads the attached
file.

## Chunking

The chunk is the unit the model reads, so it should be a unit a human would
quote.

**Code.** Reuse `extractSymbols` for top-level boundaries. A chunk runs from a
symbol's line to the next symbol's, capped at 120 lines; a longer function is
split into 120-line windows with 15 lines of overlap. The lines before the first
symbol (imports, file header) are one chunk. A file with no symbols falls back
to 80-line windows, 15 overlap. Each chunk stores `path`, `start`, `end`,
`kind: "code"`, and the symbol name when there is one.

**Markdown.** Split at headings level 1-3. A section longer than 1,200
characters is split at blank lines, 120 characters of overlap. Store the heading
path (`Retry policy > Backoff`) as a boost field.

**Text/session.** Paragraph windows of about 1,000 characters, 100 overlap. A
session entry larger than 1,200 characters is split once; the metadata
(session id, title, date, type) is stored on every piece.

**No chunk without a citation.** `path` and the line range are required; a
session chunk carries the session id and date. The answer is only useful if the
model can say where it came from.

## The index

Path: `~/.aipass/retrieval/<hash>.json`, where `<hash>` is the first 16 hex
digits of SHA-256 over the **real** root (a project reached through a junction
has one index, not two - the checkpoints store already uses this rule).
Directory `0700`, file `0600`, atomic write through `writeFileAtomic`. The home
is read at call time (`aipassHome()`), never captured at module load, so
`AIPASS_HOME` and the test suite land in the scratch home.

```json
{
  "version": 2,
  "root": "D:\\work\\app",
  "builtAt": 1790000000000,
  "files": {
    "src/auth.ts": { "mtime": 1790000000000, "size": 4201, "chunks": [0, 1, 2] }
  },
  "chunks": [
    { "path": "src/auth.ts", "start": 1, "end": 40, "kind": "code",
      "symbol": null, "text": "..." }
  ],
  "postings": { "auth": [0, 2, 7, 1] },
  "lengths": [120, 98, 144],
  "avgLen": 120.6,
  "truncated": false
}
```

`postings` is a flat `[chunkId, tf, chunkId, tf, ...]` array so the JSON stays
compact and loading is one pass. `lengths` is the weighted token count of each
chunk. `avgLen` is stored, not recomputed. The array index is the chunk id;
there is no second id to get out of sync.

**Freshness.** On a `RETRIEVE`, walk and stat (async, sorted, capped), compare
`mtimeMs + size`, and re-read only changed files. The walk is cheap compared
with reading; a 5-second TTL makes a disk edit visible without a restart and
stops a burst of questions from walking the tree for each one. Staged edits
bypass the TTL: `buildView` folds them in on every query. Deleted files lose
their chunks. `builtAt` is stamped immediately before the save, so the TTL
measures the index on disk, not the start of a slow build. The index is saved
once per build, not per file.

**Staged edits are visible.** The overlay is the run's write surface (rule 1),
and a retriever that only reads the disk would answer with the old file after
the model just edited it. At query time, `overlay.entries()` is folded in: a
staged path replaces the disk chunks for that path, a deleted path is excluded,
and a new staged file is chunked on the spot. The delta is cached by content
hash for the life of the run. This is the same rule `SEARCH` already follows
(`overlay.has(full) ? readAt(full) : readFile`).

**A build must not freeze the window (rule 9).** Use `fs.promises`, yield with
`setImmediate` every 32 files, and honor the run's abort signal. If profiling
shows the CPU tokenizer still makes the backend janky on a large tree, move the
build to a `worker_threads` worker; the JSON format is already the seam. The
symbol index's synchronous walk is the example not to copy.

**Corruption and moves.** A broken index reads as "nothing indexed" and is
rebuilt; a save failure keeps the in-memory index for the run (reporting
"not saved" is still open). The `root` in the file must match the resolved root, so a moved
project rebuilds instead of serving old paths. `aipass relocate` should delete
the old retrieval file, and the settings button can clear it.

## Retrieval

### Tokenizer

`tokenize(text)` is shared by indexing and querying:

1. NFKC-normalize and lowercase.
2. Split on non-letter/non-digit boundaries (`\p{L}\p{N}`), keeping `_`.
3. For Latin runs, split camelCase and snake_case: `refreshToken` and
   `refresh_token` both yield `refresh`, `token`; `TOKEN_TTL` yields `token`,
   `ttl`.
4. For Thai (and other scripts without spaces), use
   `new Intl.Segmenter('th', { granularity: 'word' })`. Additionally index
   character trigrams for each Thai run, prefixed `t:` (`t:โปร`, `t:ปรเ`, ...)
   so a transliteration the segmenter mangles still matches.
5. Drop tokens shorter than 2 characters and a small English/Thai stopword list
   (`the`, `and`, `for`, `ของ`, `และ`, `ที่`, ...). The IDF term already
   down-weights common words; the list is for index size, not correctness.
6. Path segments and symbol names are tokenized the same way and stored as
   separate boost fields.

### Ranking

BM25 over the weighted term frequencies:

```
idf(t) = ln(1 + (N - df(t) + 0.5) / (df(t) + 0.5))
score  = sum_t idf(t) * (tf(t) * (k1 + 1)) / (tf(t) + k1 * (1 - b + b * len / avgLen))
k1 = 1.2, b = 0.75
```

- **Field boosts.** `tf = body + 2 * path + 2 * symbol/heading`. A query that
  names a file or a function should beat a passing mention.
- **Phrase bonus.** If the normalized query phrase appears in the chunk, add
  `0.5 * sum(idf(t))`. This keeps `"retry limit"` from matching two unrelated
  lines.
- **Recency (sessions only).** `score *= 1 + 0.2 * exp(-ageDays / 30)`; code
  and docs have no recency. A decision made yesterday outranks the same words
  from last year.
- **Diversity.** Take the top 40, cap 2 chunks per file, and select with MMR
  (`lambda = 0.7`, Jaccard over token sets). Eight versions of the same comment
  are one answer, not eight.
- **Budget.** Six passages, 6,000 characters total (about 1,500 tokens),
  `AIPASS_RETRIEVAL_BUDGET` overrides. The answer says when it stopped early.

### Output

```
5 of 83 passages about "retry limit" (214 files indexed, 12s old):
src/config.ts:41-58  (const MAX_RETRIES)
  ...MAX_RETRIES = 5; the backoff starts at 200ms...

docs/retry.md:12-30  (## Retry policy)
  ...the limit is five attempts, then the caller sees...
```

No hits is an answer, not a dump:

```
nothing in the project index mentions "kubernetes helm" - 83 passages searched.
SEARCH still matches exact text; the index is ranked words, not a grep.
```

A truncated index, a stale build, or a file that could not be read is named in
the same block. The model is told these are quotations and must be treated as
data, never as instructions (the existing material rule in `protocol.mjs`).

## The agent surface

**Marker.** `RETRIEVE <query>` on one line, no body. Add it to `READING`, to
`MARKER_ATTEMPT`, and to the pre-dispatch validation (a call with no query gets
`err: RETRIEVE needs something to look for - RETRIEVE <what you want to know>`,
same shape as `RECALL`). The query passes `inbound()` like `SEARCH`.

**Preamble.** One line, gated by a `retrieve` option because the preamble bytes
are pinned by the recorded replay:

```
RETRIEVE what you are looking for - ranked passages from the project with file:line.
Use it when you do not know the exact words; SEARCH is still the exact-string tool.
```

That line is the whole advertisement. The full output shape is learned from the
first result, like every other marker.

**Fallback.** If the index cannot be built, the tool says so and names `SEARCH`.
A failed retriever must not fail the run.

**`RECALL` stays a separate marker.** It answers "what did we say", with
session and date; `RETRIEVE` answers "what does the project contain", with path
and line. They share the scorer, not the command. Merging them would make one
tool with two output shapes and no way to say which corpus was searched.

## The desktop surface

Keep it small; the index is a cache and most people should never manage it.

- **Settings.** One row in the existing context section: `ดัชนีค้นหาโปรเจกต์`,
  a toggle for the `retrieve` preamble, a status line (`N ไฟล์ / M ข้อความ,
  สร้างเมื่อ ...`), and a **ล้างดัชนี** button. No new page.
- **`/index`.** `status` (default), `clear`. Rebuild is automatic on the next
  question; a manual rebuild button is a second way to do the same thing.
- **RPC.** `retrieval.status` -> `{files, chunks, bytes, builtAt, truncated,
  root}`; `retrieval.clear` -> `{cleared: true}`. Both go through the existing
  `ctx` and the same project confinement as `files.*`.
- **No sources panel in v1.** The tool row already shows the output; a second
  list of the same passages is surface without a job. If a clickable citation
  is wanted later, the `path:start-end` string is already the link.
- **First build.** The first `RETRIEVE` may take a second or two on a medium
  project. The tool row says what it is doing (`building index: 412/900 files`)
  through the normal log/event channel; no modal.

## Privacy and security

- **The index is as sensitive as the source.** Owner-only directory and file,
  same as sessions, memory and credentials. It is machine-local; deleting it is
  the off-switch.
- **The secret floor applies at index time and at answer time.** A path that
  `secretHit` refuses is not walked; a chunk whose path is later renamed into a
  secret pattern is dropped at query time too. The tool output goes through the
  same screen as `SEARCH`'s.
- **Containment.** Only files under the resolved root; symlinks are checked
  against the root and their targets are screened, like `SEARCH` already does.
  No absolute path outside the root is stored in a chunk.
- **Prompt injection is a retrieval problem.** A README can contain "ignore
  previous instructions". The preamble already says material returned by a
  marker is data; the retrieve block repeats it once and delimits each passage.
  The model is told to cite, not obey.
- **Remote embeddings are a leak by definition.** If Phase 3 is ever enabled,
  it is per-provider and per-project, off by default, with a confirmation that
  names the provider, model, file count and byte count. Secret files are
  excluded before the first request; paths are never sent, only chunk text.
  Local Ollama (`http://127.0.0.1:11434/v1`, `nomic-embed-text`) is the
  recommended first embedding provider because the text stays on the machine.
- **No telemetry.** Retrieval stats stay in the local session log.

## Failure behavior

| failure | answer |
|---|---|
| no index yet, first call | build, then answer; the first result carries `built just now` |
| project has no text files | `nothing to index - no text files under <root>` |
| index corrupt or version changed | treat as empty, rebuild, say `index rebuilt` |
| save failed (read-only home, disk full) | answer from memory; reporting `index not saved` is still open; next run rebuilds |
| file changed mid-build | the stat after the read wins; the next query rebuilds once the 5 s TTL expires |
| cap hit (5,000 files / 20,000 chunks) | answer from the capped index, say `indexed 20,000 of N chunks` and how to narrow |
| query too short | `err:` with the shape, same as `RECALL` |
| run stopped | abort the walk and the tokenizer loop; no partial write (no save); the next run rebuilds |
| embedding provider down (Phase 3) | fall back to lexical, say `embeddings unavailable`; never block the answer |

## Evals and tests

Phase 1 is not done until these are green:

**Unit (`test/retrieval.test.mjs`)**

- a Thai question finds a Thai paragraph whose words are segmented differently
  from the question (`Intl.Segmenter` + trigram fallback);
- `refresh token` ranks the file that defines `refreshToken` above a file that
  mentions "token" in a comment;
- code chunks break at symbol boundaries and never exceed the line cap;
- a changed file is re-read, an unchanged file is not (a counter or an mtime
  assertion, not a timing test);
- a staged edit is visible before Apply; a staged delete is invisible; a staged
  secret, generated file or dotfile never enters the answer;
- clearing the index cancels an in-flight build and leaves no index file;
- a disk edit is visible after the 5 s TTL;
- `.gitignore`, dotfiles, secret names and out-of-root symlinks never enter the
  index;
- the index file is `0600` where POSIX modes exist; a corrupt index rebuilds;
- no hits says so and does not dump the corpus;
- the `RETRIEVE` marker parses; a malformed one is an `err:`; the preamble only
  teaches it when `retrieve` is on.

**Offline benchmark (`test/retrieval-bench.test.mjs`, a small fixture)**

- Three sets in `evals/retrieval`: 24 exact queries, 14 paraphrase queries, 6
  negative queries. The fixture includes keyword-stuffed distractor notes, so
  ranking is not free.
- Exact: every expected path must be in the top 8 for a multi-file question;
  assert `recall@8 >= 0.9` and `MRR@8 >= 0.8`. The measured baseline is 1.000
  recall and 0.958 MRR.
- Paraphrase: reported separately with a regression floor (`any-match recall@8
  >= 0.1`), not a semantic gate. The measured lexical baseline is 0.214; that
  miss rate is the Phase 3 gate evidence.
- Negative: unrelated queries must return no hits.
- `npm run bench:retrieval` prints the same numbers; `--repo <path>` runs
  `queries-real.json` against a real project and hides the benchmark's own files
  from the corpus; `--strict` exits 1 when the exact or negative floor is missed.
- No query returns more than the budget. Numbers are pinned in the test so a
  regression names itself.

**Live (optional, `evals/tasks/retrieval-*`)**

- a task whose answer is in the repo but not under an exact keyword; the check
  is the edit, not the model's prose. Run in replay with a recorded transcript
  only after the preamble bytes stop moving.

**Existing tests**

- `node --test aipass-bridge/test/recall.test.mjs` must stay green through the
  Phase 2 refactor; the output shape is a contract.
- `npm test` must end `fail 0`; `npm run typecheck` must pass (`jsconfig`).

## Phases

| phase | scope | files |
|---|---|---|
| **0 - design** | this document | `docs/RAG_DESIGN.md` |
| **1 - lexical MVP** | index, chunker, tokenizer, BM25, `RETRIEVE`, status/clear, tests | new `harness/retrieval.mjs`; `harness/protocol.mjs`, `harness/tools.mjs`, `harness/validate.mjs`, `harness/settings.mjs`, `harness/rpc*.mjs`, `desktop/ui` settings, `docs/DATA_FORMATS.md`, `docs/MATURITY.md` |
| **1.5 - hardening** | clear cancels a build, staged overlay obeys the secret/generated/dot filters, 5 s TTL, exact/paraphrase/negative benchmark split | `harness/retrieval.mjs`, `test/retrieval*.test.mjs`, `evals/retrieval/**`, `scripts/retrieval-bench.mjs` |
| **2 - past** | `RECALL` on the shared tokenizer, Thai segmentation, memory facts as documents | `harness/memory-store.mjs`, `harness/tools.mjs`, `test/recall.test.mjs` |
| **3 - embeddings (gated)** | provider embeddings, vectors in the index, RRF, consent row | `harness/providers.mjs`, `harness/provider-client.mjs`, `harness/retrieval.mjs`, settings UI |

Phase 1 is the smallest complete change: it answers "where is this?" for a
project whose exact words the person does not know. Phase 2 is the same change
applied to the past. Phase 3 is not started unless the benchmark says the
lexical retriever is missing queries that a vector would catch.

## Not in this design

- **A vector database or an ANN index.** Brute-force cosine over a capped
  chunk set is a few lines and fast enough for a desktop project. HNSW is a
  dependency and a tuning problem; add it only when a measured p95 says so.
- **A PDF/Office parser.** Attachments already let the provider read those
  files; a local text extractor is a separate project and a new dependency.
- **Cross-project search.** One project root, one index. A global index would
  cross the containment and secret rules that make the current tools safe.
- **Automatic indexing of `node_modules`, build output or `.git`.** Those are
  not the project's knowledge; they are its dependencies and its history.
- **A second UI for asking questions.** The model asks `RETRIEVE`; the human
  asks the model. `/index` is for trust and cleanup, not a search box.
- **An LLM reranker or query expander.** Both spend credits and add a failure
  mode to a path that should be deterministic. Revisit only with a benchmark.

## Open questions

1. **Default on or off?** Recommendation: `retrieve: true` in the desktop
   (one preamble line, off-switch in settings), same for the CLI. If the live
   eval shows the model overusing it on trivial edits, default it off and let
   the person turn it on.
2. **Sessions first or project first?** Recommendation: project first - it is
   the bigger corpus and the current `SEARCH` gap - then `RECALL` in Phase 2.
3. **Should the first-turn carry use the retriever?** The current `carryFacts`
   is a good budgeted heuristic. Replacing it with BM25 over facts is a Phase 2
   measurement, not a rewrite.
4. **Where does a document library live?** `~/.aipass/knowledge/<project>/`
   (owner-only, outside the tree) is the shape that fits the checkpoint and
   memory stores. Not designed until Phase 3 is on the table.

## Checked, not assumed

- `node --test aipass-bridge/test/recall.test.mjs` - 5/5 pass on 2026-10-29.
- `node --test aipass-bridge/test/retrieval.test.mjs` - 21/21 pass on 2026-10-29.
- `node --test aipass-bridge/test/retrieval-bench.test.mjs` - 4/4 pass on
  2026-10-29; exact recall 1.000, MRR 0.958; paraphrase recall 0.214; all six
  negative queries returned no hits.
- `npm run bench:retrieval -- --repo D:\aipass` on 2026-10-29: 843 files, 6,714
  chunks, cold build 2.8 s, incremental 307 ms (read 8, reused 843), query p50
  6 ms / p95 12 ms, real-query recall 80% / MRR 0.500 with `evals/retrieval`
  hidden from the corpus.
- `Intl.Segmenter('th')` is present in the runtime (Node 24.18.0) and splits
  `ระบบค้นคืนความรู้สำหรับโปรเจกต์` into words; it also splits `โปรเจกต์` into
  `โปร | เจ | กต์`, hence the trigram fallback.
- The current caps and defaults above are read from the source, not from the
  README: `memory-store.mjs` (30/128 KB/8/280, 50 facts, 2,400 chars),
  `tools.mjs` (50 matches, 1 MB search cap, 20 MB attach cap), `settings.mjs`
  (`searchI: false`, `recall: true`), `rpc.mjs` (60 s path index).
