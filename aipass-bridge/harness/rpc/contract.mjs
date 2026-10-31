// @ts-check
// The single source of truth for the /rpc surface.
//
// Every method the backend answers lives in one of the `create*Methods`
// factories in this folder. This file names them all, in one place, so that:
//   1. `scripts/agents-lint.mjs` and the suite can ask "does the contract
//      name the methods the backend has?" and get one answer.
//   2. A new method has to be added here in the same change that adds it to a
//      factory - the contract test fails otherwise (drift is a build break).
//   3. JSDoc typedefs for params and results live next to the names, so the
//      window and the harness share one shape instead of two guesses.
//
// Constraint 4 (zero deps) holds: this is plain ESM + JSDoc, nothing ships.
// The typedefs are intentionally loose (`any`) for methods whose shape is not
// yet pinned; tightening one is a normal change and is how the contract grows.
//
// @ts-check

/**
 * @typedef {Record<string, any>} RpcParams
 * @typedef {any} RpcResult
 */

/**
 * Every method the backend owns, sorted. Grouped below by domain for reading;
 * the flat list is what the tests compare against `Object.keys(methods)`.
 *
 * @type {ReadonlyArray<string>}
 */
export const METHODS = Object.freeze([
  'apply',
  'attachment.list',
  'attachment.remove',
  'attachment.stage',
  'browser.open',
  'cancel',
  'checkpoints.list',
  'checkpoints.remove',
  'checkpoints.restore',
  'compact',
  'config.set',
  'conversation.new',
  'conversation.pin',
  'conversations',
  'conversations.list',
  'credits',
  'diff',
  'discard',
  'extension.install',
  'fs.grep',
  'fs.list',
  'fs.read',
  'fs.search',
  'git.branch',
  'git.commit',
  'git.stage',
  'git.status',
  'goal.block',
  'goal.clear',
  'goal.done',
  'goal.get',
  'goal.pause',
  'goal.resume',
  'goal.set',
  'hooks.get',
  'hooks.set',
  'mcp.add',
  'mcp.disable',
  'mcp.enable',
  'mcp.list',
  'mcp.reload',
  'mcp.remove',
  'mcp.test',
  'media.generate',
  'media.models',
  'media.options',
  'media.styles',
  'memory.clear',
  'memory.list',
  'models',
  'pair.code',
  'panel.render',
  'pending',
  'permission.answer',
  'plan.answer',
  'plugins.disable',
  'plugins.enable',
  'plugins.inspect',
  'plugins.install',
  'plugins.list',
  'plugins.reload',
  'plugins.remove',
  'projects.add',
  'projects.list',
  'projects.remove',
  'projects.switch',
  'provider.remove',
  'provider.save',
  'provider.set',
  'provider.test',
  'providers.list',
  'retrieval.clear',
  'retrieval.status',
  'rules.get',
  'rules.set',
  'run',
  'run.inject',
  'schedule.add',
  'schedule.list',
  'schedule.remove',
  'schedule.runDue',
  'session.archive',
  'session.archived',
  'session.delete',
  'session.entries',
  'session.export',
  'session.fork',
  'session.list',
  'session.new',
  'session.open',
  'session.prune',
  'session.rename',
  'session.tree',
  'session.unarchive',
  'settings.get',
  'settings.reset',
  'settings.set',
  'shell.reveal',
  'skills.index',
  'skills.install',
  'skills.list',
  'skills.load',
  'skills.remove',
  'snapshot',
  'status',
  'symbols.def',
  'symbols.list',
  'symbols.refs',
  'update.apply',
  'update.check',
  'update.install',
  'update.rollback',
  'update.state',
  'waf.table',
  'worktree.create',
  'worktree.list',
  'worktree.remove',
  'worktree.status',
  'worktree.sweep',
]);

/**
 * Method names grouped by domain, for reading. The keys are the factory files
 * that own them; the values are a subset of {@link METHODS}.
 *
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
 */
export const METHOD_GROUPS = Object.freeze({
  core: ['status', 'snapshot', 'models', 'credits'],
  session: ['run', 'cancel', 'pending', 'compact', 'diff', 'apply', 'discard', 'conversations', 'run.inject'],
  files: ['fs.list', 'fs.read', 'fs.search', 'fs.grep', 'attachment.stage', 'attachment.list', 'attachment.remove'],
  git: ['git.status', 'git.stage', 'git.commit', 'git.branch'],
  worktree: ['worktree.create', 'worktree.list', 'worktree.remove', 'worktree.status', 'worktree.sweep'],
  settings: ['settings.get', 'settings.set', 'settings.reset', 'config.set', 'rules.get', 'rules.set'],
  providers: ['providers.list', 'provider.save', 'provider.remove', 'provider.set', 'provider.test'],
  plugins: ['plugins.list', 'plugins.install', 'plugins.remove', 'plugins.enable', 'plugins.disable', 'plugins.inspect', 'plugins.reload'],
  mcp: ['mcp.list', 'mcp.add', 'mcp.remove', 'mcp.enable', 'mcp.disable', 'mcp.reload', 'mcp.test'],
  media: ['media.models', 'media.options', 'media.styles', 'media.generate'],
  update: ['update.check', 'update.apply', 'update.rollback', 'update.install', 'update.state'],
  goal: ['goal.get', 'goal.set', 'goal.pause', 'goal.resume', 'goal.done', 'goal.block', 'goal.clear'],
  hooks: ['hooks.get', 'hooks.set'],
  memory: ['memory.list', 'memory.clear'],
  projects: ['projects.list', 'projects.add', 'projects.remove', 'projects.switch'],
  sessions: [
    'session.list', 'session.new', 'session.open', 'session.rename', 'session.delete',
    'session.fork', 'session.entries', 'session.export', 'session.tree', 'session.archive',
    'session.archived', 'session.unarchive', 'session.prune',
  ],
  conversations: ['conversations.list', 'conversation.new', 'conversation.pin'],
  checkpoints: ['checkpoints.list', 'checkpoints.restore', 'checkpoints.remove'],
  symbols: ['symbols.list', 'symbols.def', 'symbols.refs'],
  skills: ['skills.list', 'skills.load', 'skills.install', 'skills.remove', 'skills.index'],
  extension: ['extension.install', 'browser.open', 'shell.reveal'],
  retrieval: ['retrieval.status', 'retrieval.clear'],
  schedule: ['schedule.list', 'schedule.add', 'schedule.remove', 'schedule.runDue'],
  waf: ['waf.table', 'pair.code'],
  panel: ['panel.render'],
  permissions: ['permission.answer', 'plan.answer'],
  updateFeed: [],
});

/**
 * @param {string} name
 * @returns {boolean}
 */
export function hasMethod(name) {
  return METHODS.includes(name);
}

/**
 * Params/result shapes. Tighten these as the contract grows; a method that is
 * not listed here falls back to `any`, which is the honest starting state.
 *
 * @typedef {object} StatusParams
 * @property {string} [project]
 *
 * @typedef {object} StatusResult
 * @property {string} root
 * @property {boolean} bridge
 * @property {number} extensions
 *
 * @typedef {object} RunParams
 * @property {string} task
 * @property {string} [title]
 * @property {string} [model]
 * @property {string} [project]
 *
 * @typedef {object} RunResult
 * @property {string} sessionId
 * @property {string} [stopReason]
 */

/**
 * Map a method name to its params type. Used by callers that want a checked
 * call site: `/** @type {import('./contract.mjs').ParamsFor<'run'>} *\/`.
 *
 * @template {string} M
 * @typedef {M extends 'status' ? StatusParams
 *   : M extends 'run' ? RunParams
 *   : RpcParams} ParamsFor
 */

/**
 * Map a method name to its result type.
 *
 * @template {string} M
 * @typedef {M extends 'status' ? StatusResult
 *   : M extends 'run' ? RunResult
 *   : RpcResult} ResultFor
 */
