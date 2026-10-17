// Plugins — the seam between the harness and whatever it cannot anticipate.
//
// A plugin is one .mjs file in `~/.aipass/plugins` (or a folder with a
// plugin.mjs) that default-exports `{ name, version, setup(ctx) }`. Through
// `ctx` it can:
//
//   rpc.method(name, fn)      answer a new /rpc method — the window calls it
//   tools.register(marker, …) teach the model a new marker, e.g. `NOTE …`
//   panel({id, title, render}) add a section to the window's sidebar
//   settings.define({key, …}) add a setting the window renders for you
//   events.on(type, fn)       watch a run as it happens
//
// Everything runs in this process, with the same access the harness has —
// including the filesystem. That is the deal: plugins are code you chose to
// install, not sandboxed. Load only what you have read.
//
// Compatibility: the ctx surface above is `PLUGIN_API` 1. Within one major
// the harness only ever grows ctx — new helpers, never new required fields —
// and a plugin marker can never shadow a built-in one. A plugin may declare
// `apiVersion`; one that needs a newer harness than this build is refused at
// load before setup() runs, and one that declares nothing loads as
// `apiVersion: null` (read: 1). `details()` carries whichever it was.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { aipassHome } from './settings.mjs';
import { pathToFileURL } from 'node:url';

export const PLUGIN_API = 1;

export class PluginManager {
  constructor({ dir = path.join(aipassHome(), 'plugins'), settings = null, events = null, log = () => {} } = {}) {
    this.dir = dir;
    this.settings = settings;
    this.events = events;
    this.log = log;
    this.loaded = [];        // [{name, version, description, file}]
    this.failed = [];        // [{file, error}]
    this._methods = new Map();
    this._panels = [];
    this._tools = new Map(); // marker → {impl, takesBody, description, plugin}
    this._settingDefs = [];
  }

  get defaultDir() { return this.dir; }

  /** Every plugin file in the directory: *.mjs and <folder>/plugin.mjs. */
  discover() {
    const out = [];
    let entries = [];
    try { entries = fs.readdirSync(this.dir, { withFileTypes: true }); } catch { return out; }
    for (const entry of entries) {
      const full = path.join(this.dir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.mjs')) out.push(full);
      else if (entry.isDirectory()) {
        const nested = path.join(full, 'plugin.mjs');
        if (fs.existsSync(nested)) out.push(nested);
      }
    }
    return out.sort();
  }

  /** Name filter: an empty list in settings means "everything found". */
  #wanted(name) {
    const list = this.settings?.get('plugins') ?? [];
    return !Array.isArray(list) || list.length === 0 || list.includes(name);
  }

  async load() {
    this.loaded = [];
    this.failed = [];
    this._methods.clear();
    this._panels = [];
    this._tools.clear();
    this._settingDefs = [];

    for (const file of this.discover()) {
      try {
        // Provenance, not security: a plugin is code the user installed, and
        // the record of what was actually loaded — content hash, size, mtime —
        // is what makes "did that plugin change since it last behaved?" an
        // answerable question without re-reading every file by hand.
        const bytes = fs.readFileSync(file);
        const stat = fs.statSync(file);
        const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
        const plugin = mod.default ?? mod;
        if (typeof plugin?.setup !== 'function') throw new Error('no default export with a setup(ctx) function');
        const name = plugin.name ?? path.basename(file);
        // The filter is read before setup runs. Setup is what registers
        // everything: a disabled plugin that was set up first and filtered
        // afterwards would keep its tools, methods and panels live while the
        // listing said the plugin was off — "disabled in settings" has to mean
        // nothing of it is loaded, not that the window forgot to mention it.
        if (!this.#wanted(name)) {
          this.log(`plugin ${name} is disabled in settings — not registering it`);
          continue;
        }
        // A plugin that needs a newer API must not run setup at all: half a
        // plugin registered against a harness it does not understand is
        // worse than a named refusal. Silence means API 1 (the only one).
        const api = plugin.apiVersion ?? null;
        if (api !== null && (!Number.isInteger(api) || api < 1 || api > PLUGIN_API)) {
          throw new Error(`plugin apiVersion ${api} needs a newer harness (this build speaks ${PLUGIN_API})`);
        }
        const ctx = this.#context(plugin);
        await plugin.setup(ctx);
        this.loaded.push({
          name,
          version: plugin.version ?? '0.0.0',
          description: plugin.description ?? '',
          apiVersion: api,
          file,
          sha256: crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16),
          bytes: stat.size,
          modified: Math.round(stat.mtimeMs),
        });
      } catch (err) {
        this.failed.push({ file, error: String(err.message ?? err) });
        this.log(`plugin ${path.basename(file)} failed to load: ${err.message}`);
      }
    }
    this.events?.emit('plugins', { loaded: this.loaded.length, failed: this.failed.length });
    return this.details();
  }

  #context(plugin) {
    const name = plugin.name ?? 'plugin';
    return {
      name,
      settings: this.settings,
      events: this.events,
      log: (text) => this.log(`[${name}] ${text}`),

      rpc: {
        method: (method, fn) => {
          if (typeof method !== 'string' || typeof fn !== 'function') throw new Error('rpc.method(name, fn)');
          this._methods.set(method, { fn, plugin: name });
        },
      },

      tools: {
        // The model writes `MARKER rest-of-line` (or a block ending in END when
        // takesBody is true) and gets the string back as a tool result.
        register: (marker, impl, { takesBody = false, description = '' } = {}) => {
          if (!/^[A-Z][A-Z0-9_-]*$/.test(marker)) throw new Error(`marker must be UPPER_SNAKE, got ${marker}`);
          if (typeof impl !== 'function') throw new Error('tools.register(marker, fn)');
          this._tools.set(marker, { impl, takesBody, description, plugin: name });
        },
      },

      panel: (def = {}) => {
        if (!def.id || !def.title) throw new Error('panel({id, title, render})');
        this._panels.push({
          id: def.id,
          title: def.title,
          plugin: name,
          // A panel is rendered across the process boundary, so it returns
          // markup (trusted: the plugin is code the user installed), not DOM
          // nodes. `render` may be async.
          render: def.render,
        });
      },

      settings: {
        define: (def = {}) => {
          if (!def.key) throw new Error('settings.define({key, …})');
          this._settingDefs.push({ plugin: name, ...def });
        },
      },
    };
  }

  /** What the window shows, and what /rpc answers. */
  details() {
    return {
      dir: this.dir,
      loaded: this.loaded,
      failed: this.failed,
      tools: [...this._tools.keys()],
      // The same table the protocol parser gets, for callers that have to
      // consume a marker's body or not — the window's transcript renderer
      // hides plugin marker blocks, and a body it eats wrongly would be a
      // paragraph the reader never saw.
      toolDefs: this.toolTable(),
      panels: this._panels.map((p) => ({ id: p.id, title: p.title, plugin: p.plugin })),
      settings: this._settingDefs,
    };
  }

  hasMethod(name) { return this._methods.has(name); }
  async callMethod(name, params = {}) {
    const entry = this._methods.get(name);
    if (!entry) throw new Error(`no plugin provides ${name}`);
    return entry.fn(params);
  }

  /** The marker table handed to the protocol parser and the preamble. */
  toolTable() {
    return [...this._tools.entries()].map(([marker, def]) => ({ marker, takesBody: def.takesBody, description: def.description, plugin: def.plugin }));
  }

  async runTool(marker, { arg = '', body = '' } = {}) {
    const def = this._tools.get(marker);
    if (!def) return `no such plugin tool: ${marker}`;
    return String(await def.impl({ arg, body }) ?? '');
  }

  /** Panels are rendered in the window, across the process boundary. */
  async renderPanel(id) {
    const panel = this._panels.find((p) => p.id === id);
    if (!panel) throw new Error(`no panel ${id}`);
    const out = await panel.render();
    return { id, title: panel.title, plugin: panel.plugin, html: out?.html ?? '' };
  }

  async reload() { return this.load(); }
}

export default PluginManager;
