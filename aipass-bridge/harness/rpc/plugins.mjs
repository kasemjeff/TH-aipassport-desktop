// The plugins and MCP domain: code the model may call, and the tools it may
// use from outside.
//
// A plugin is code the person installed: it may add markers the model calls,
// and it may paint a panel the window shows. An MCP server is somebody else's
// program the harness runs as a child process. Both are asked about, both are
// listed in the same sheet, and both answer with the same shapes the window
// already knows.
import {
  inspectSource, installSource, finalizeInstall, removePlugin, readRegistry,
  decorateDetails, stripFromEnabled, NONE_NAME,
} from '../install.mjs';
import { loadConfig, addServer, removeServer, testServer } from '../mcp.mjs';
import { aipassHome } from '../settings.mjs';

/**
 * The plugins methods of the backend.
 *
 * @param {import('./context.mjs').RpcContext} ctx the shared backend state
 */
export function createPluginMethods(ctx) {
  const {
    appSettings,
    plugins,
    targetFor,
    decoratedPlugins,
    pluginSetEnabled,
    mcpListing,
    mcpSetEnabled,
    emit,
    root,
  } = ctx;

  return {

    /* ------------------------------------------------------------- plugins */
    async 'plugins.list'() {
      // The startup load may still be running: a window that asks in the
      // first moments after the backend came up would be told "no plugins"
      // and paint an empty list for the life of the window. The load is
      // already on its way — wait for it rather than answer about a
      // half-loaded set.
      await ctx.pluginsReady;
      return decoratedPlugins();
    },
    async 'plugins.reload'() {
      await plugins.load();
      const details = decoratedPlugins();
      emit('plugins', details);
      return details;
    },
    /** Report on a source (path, folder, URL) — size and hash, nothing runs. */
    async 'plugins.inspect'(params = {}) {
      return inspectSource(params.source, { base: ctx.current?.root ?? process.cwd() });
    },
    async 'plugins.install'(params = {}) {
      const result = await installSource(params.source, {
        name: params.name ?? null,
        expectedSha256: params.expectedSha256 ?? null,
        force: Boolean(params.force),
        base: ctx.current?.root ?? process.cwd(),
        pluginsDir: plugins.defaultDir,
        installedBy: params.installedBy === 'cli' ? 'cli' : 'desktop-ui',
      });
      // A non-empty enabled-list is an exact list of what runs. Leaving the new
      // plugin out of it would install it into silence, which reads as a failed
      // install; adding it here is the same decision as enabling it.
      const list = appSettings.get('plugins');
      if (Array.isArray(list) && list.length && !list.includes(result.name)) {
        appSettings.set({ plugins: [...list.filter((n) => n !== NONE_NAME), result.name] });
      }
      const details = await finalizeInstall(result, plugins);
      const decorated = decorateDetails(details, readRegistry(plugins.defaultDir));
      emit('plugins', decorated);
      return { plugin: decorated.loaded.find((p) => p.name === result.name) ?? null, details: decorated };
    },
    async 'plugins.remove'(params = {}) {
      const out = removePlugin(params.name, { pluginsDir: plugins.defaultDir, force: Boolean(params.force) });
      // Removing a name from an explicit enabled-list keeps the list exact: a
      // name that no longer exists would otherwise be the only thing standing
      // between "these plugins" and "everything, now and later".
      const list = appSettings.get('plugins');
      if (Array.isArray(list) && list.includes(params.name)) {
        appSettings.set({ plugins: stripFromEnabled(list, params.name) });
      }
      await plugins.load();
      const details = decoratedPlugins();
      emit('plugins', details);
      return { ...out, details };
    },
    async 'plugins.enable'(params = {}) { return pluginSetEnabled(params.name, true); },
    async 'plugins.disable'(params = {}) { return pluginSetEnabled(params.name, false); },
    async 'panel.render'(params = {}) { return plugins.renderPanel(params.id); },

    /* --------------------------------------------------------------- mcp tools */

    async 'mcp.list'(params = {}) {
      const h = targetFor(params);
      await h.mcp.ensureLoaded();
      return mcpListing(h);
    },
    async 'mcp.reload'(params = {}) {
      const h = targetFor(params);
      await h.mcp.reload();
      return mcpListing(h);
    },
    async 'mcp.add'(params = {}) {
      const h = targetFor(params);
      const server = addServer(params, { home: aipassHome(), root: h.root });
      await h.mcp.reload();
      return { server, ...mcpListing(h) };
    },
    async 'mcp.remove'(params = {}) {
      const h = targetFor(params);
      const out = removeServer(params.name, { home: aipassHome(), root: h.root, scope: params.scope ?? null });
      await h.mcp.reload();
      return { ...out, ...mcpListing(h) };
    },
    async 'mcp.enable'(params = {}) { return mcpSetEnabled(params, true); },
    async 'mcp.disable'(params = {}) { return mcpSetEnabled(params, false); },
    /**
     * Try a definition that may not be saved yet (a form's "test" button), or
     * a name that is (the card's). A saved name resolves through the config,
     * so the test runs exactly what is on disk — project override included.
     */
    async 'mcp.test'(params = {}) {
      // The project the call is about: a test that runs against the config of
      // another project proves nothing about the one the reader is on.
      const root = targetFor(params).root;
      if (!params.name) return testServer(params, { root });
      const known = loadConfig(root).find((s) => s.name === params.name && (!params.scope || s.scope === params.scope));
      if (!known) throw new Error(`no server named ${params.name}`);
      return testServer(known, { root });
    },
  };
}

export default createPluginMethods;
