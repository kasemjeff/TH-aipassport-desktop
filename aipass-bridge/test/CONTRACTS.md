# CONTRACTS.md — the tests that pin what this suite holds

> Every title below is a contract: a behaviour somebody decided the product
> must have, pinned by a test whose name says so. `AGENTS.md` files cite them
> with `Verify:` anchors, and `scripts/agents-lint.mjs` checks that every
> anchor names a real test — so renaming a test without saying what it now
> pins breaks the build.

**The rule.** This file is an INDEX, not a guide: the guides (`AGENTS.md`)
hold the law, and this file holds the list of what the law currently points
at. It has a size budget like any other guide, and it is cut — not raised —
when it grows.

**Adding a line here.** A behaviour earns a line when it is one somebody would
be sad to lose: a safety boundary, a promise the window makes to the person, or
a rule about who may do what. The title must be the test's exact name, because
the lint compares the two as strings.

---

## The write can be taken back, and the root is physical.

Verify: "an applied change can be restored"
Verify: "a restore puts the bytes back exactly"
Verify: "a checkpoint never lands inside the project"
Verify: "a write into a linked heavy directory does not land in the real tree"
Verify: "a staged write into a shared heavy directory is refused"
Verify: "an apply does not write into a shared heavy directory"
Verify: "a read into a shared heavy directory still works"

## A run is given a power, it never takes one.

Verify: "the GIT tool refuses a write subcommand until it is allowed"
Verify: "a git write asks before it runs"
Verify: "the model can ask for a check"
Verify: "a VERIFY without a declared check says so"

## The account does more than chat, and the file is kept.

Verify: "a generated image is saved where it was asked to go"
Verify: "an option a model does not declare is dropped before the request"

## The extension channel is authenticated, and a timeout costs nothing.

Verify: "the bridge refuses an /ext post that does not carry the per-run token"
Verify: "a job that times out tells the extension to stop"

## Nothing grows because nobody was watching.

Verify: "switching projects does not duplicate the MCP markers"
Verify: "a subscriber that stops reading does not grow the backend without bound"
Verify: "the window is told it fell behind, and how much it lost"
Verify: "the window says it lost frames"
Verify: "the transcript drops its oldest rows and says how many"

## A session can be kept, and a task can wait for its hour.

Verify: "an exported session keeps every entry"
Verify: "the session tree groups the sessions by day"
Verify: "a due schedule entry is due once and then spent"
Verify: "the media models come with the options they accept"
Verify: "a provider that never answers does not hang the run"

## The past is reachable, and the person's own commands run.

Verify: "the past answers a question about it"
Verify: "a recall of nothing says so, instead of returning the whole store"
Verify: "the recall reads the newest first, and the newest wins a tie"
Verify: "a hook runs after the run stages a change"
Verify: "a hook runs when the run ends"
Verify: "a hook's output is screened for secrets"
Verify: "a hook that fails is reported, and the run continues"
Verify: "a hook that names a secret file is not run"
Verify: "a hook command is one command, split into an argv array"
Verify: "a hook before a commit refuses the commit when it fails"
Verify: "a hook is not asked for permission — the person configured it"

## A run can work in its own checkout.

Verify: "a worktree is made outside the project, and it is a real checkout"
Verify: "the files a run wrote in a worktree are not in the working tree"
Verify: "a worktree can be taken away again"
Verify: "a worktree nobody wants is swept, and one with work in it is kept"
Verify: "a path that leaves the worktree folder is refused"
Verify: "the worktree methods make, list, read and take away a checkout"
Verify: "the sweep keeps a worktree that is still young"

## The window reaches all of it, and says what it did.

Verify: "the checkpoint list names the files it can bring back"
Verify: "a restore says what came back and what was removed"
Verify: "the apply says the write can be taken back"
Verify: "the git page commits with a message, and refuses an empty one"
Verify: "the media page shows only the options the chosen model takes"
Verify: "the media page says what the render dropped"
Verify: "the schedule page lists the tasks and runs what is due"
Verify: "the export writes the transcript where the person says"
Verify: "the tree lists the sessions of the project, grouped by day"
Verify: "the window's marker list is the harness's, keyword for keyword"
Verify: "a VERIFY line is wire, never prose in the bubble"
Verify: "the panels a plugin draws are on screen while the window works"
Verify: "a session row can export its transcript without opening it"
Verify: "an archived session can be put back"
Verify: "the history rail groups the sessions by day"
Verify: "the sheet offers the hooks the person configured"
Verify: "the window names the worktree it is running in"
Verify: "the window offers to work in a worktree and to make one"
