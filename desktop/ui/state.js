// The window's own state.
//
// Everything the page remembers between two calls to the backend lives here:
// the project it is showing, the run in flight, the staged changes, the
// attachments, the session, the plugins.
//
// It is a factory, not a module-level object: the window's tests boot the
// page again and again, and a state that survived from the boot before would
// be the wrong state — a stale project, a stale session id, a half-open run.
//
// Every module of the window reads this one object, so there is one answer
// to "what is the window showing right now".
export function createState() {
  return {
    // The project this window shows. rpc tags every run event with the project
    // that emitted it, and the window drops events tagged for another one (see
    // onRun); it also rides every run/cancel call, so the backend runs where the
    // window is looking even if another window moved it since (rpc.mjs run).
    root: null,
    running: false,
    assistant: null,      // { el, text, tail }
    thinking: null,       // { el, text, box, summary, since }
    pending: new Map(),   // file → {checked, added, removed, deleted, isNew}
    attachments: new Map(), // id → {name, bytes, mime}
    sessionId: null,
    settings: null,
    // Which provider the run talks to: the built-in AiPASS one (the local
    // bridge and its tab) or an added API provider. The picker is the switch.
    provider: 'aipass',
    providers: [],
    plugins: null,
    pluginTools: [],      // {marker, takesBody} — what the transcript must hide
    pluginPanels: [],     // the panels the plugins paint — the sheet draws them
    skills: [],           // the playbooks on disk — the settings sheet lists them
    panelHost: null,      // the settings sheet's panel area, when it is open
    needsTab: false,      // the last run could not proceed for want of a chat tab
    // What the bridge says about the extension's own token: 'ok' or 'missing'.
    // The extension talks to the bridge, not to the window, so a refusal there
    // reaches the reader only as "no extension connected" — and the two have
    // different fixes. The bridge reports which one it is.
    extensionToken: 'ok',
    needsCompaction: false, // the budget is close to full and a rotation is coming
    runCursor: null,      // where in the log the live run's rows begin
    stopping: false,      // a stop was asked for; the run is winding down
    // The last bubble, kept after the step boundary closes it: the step's
    // headline arrives after that boundary, and it is the first line of the
    // prose this bubble is already showing.
    lastBubble: null,
    modalReturnFocus: null, // where the focus was before the sheet took it
    // Whether the model picker is the sheet on screen. Its Ctrl+R refreshes
    // the list in place, and the global Ctrl+R stays a page reload.
    modelPicker: false,
  };
}

export default createState;
