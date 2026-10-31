// @ts-check
// The shape the backend's domain modules share.
//
// `createRpc` builds one context and hands it to every domain module, so the
// handlers agree on where the harnesses are, who the current project is and
// how a frame is published — without any of them reaching into the closure
// that made them. The typedef lives here so a domain module can be read on
// its own: what it may touch is written down.
//
// The context is written once, at boot, and read many times. The one thing it
// cannot hold is the current harness: that moves when the person switches
// project, so it is a getter, not a value.

/**
 * The backend state every domain module is handed.
 *
 * @typedef {object} RpcContext
 * @property {import('../settings.mjs').Settings} appSettings   the settings file
 * @property {import('../providers.mjs').ProviderStore} providers the provider registry
 * @property {import('../plugins.mjs').PluginManager} plugins   the plugin manager
 * @property {Map<string, import('../harness.mjs').Harness>} harnesses one per project
 * @property {Map<string, string|null>} runSessions  the session each run writes to
 * @property {import('../harness.mjs').Harness} current the project the backend is on
 * @property {Map<string, object>} staged            the attachments waiting to be sent
 * @property {Function} targetFor        the harness a call is about
 * @property {Function} switchProject    move the backend to another project
 * @property {Function} applySettingsTo  apply the settings file to one harness
 * @property {Function} applyProviderTo  move one harness to a provider
 * @property {Function} activeProviderId the provider the runs talk to
 * @property {Function} skillLibraryFor  the playbooks of one project
 * @property {Function} decoratedPlugins the plugin list, as the window wants it
 * @property {Function} pluginSetEnabled  turn a plugin on or off
 * @property {Function} mcpListing       the MCP servers and their tools
 * @property {Function} mcpSetEnabled    turn an MCP server on or off
 * @property {Function} stageAttachment  stage one attachment
 * @property {Function} dropAttachment   unstage one attachment
 * @property {Function} partsFor         the attachment parts of a send
 * @property {Function} holdFinished     hold a project's "finished" frame (attempts)
 * @property {Function} fileIndex        the tree index of one project
 * @property {Function} dropIndex        forget the tree index of one project
 * @property {Function} checkForUpdates  ask the signed feed what is out there
 * @property {Function} emit             publish a frame to every listener
 * @property {string} bridgeURL          the local bridge
 * @property {string} root               the folder the backend started on
 * @property {string|null} model         the model a run starts on
 * @property {string} APP_ROOT           where this install's files live
 * @property {Record<string, Function>} methods every method, for the ones that call another
 */

export {};
