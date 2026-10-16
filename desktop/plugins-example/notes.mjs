// The example plugin: a scratchpad the model can write to.
//
// This is the whole API in one file — a tool the model can call, a panel in the
// window, a setting, and an RPC method. Drop it in ~/.aipass/plugins and
// restart the backend (or press "reload plugins" in settings).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FILE = () => path.join(os.homedir(), '.aipass', 'notes.md');

const read = () => {
  try { return fs.readFileSync(FILE(), 'utf8'); } catch { return ''; }
};
const write = (text) => {
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  fs.writeFileSync(FILE(), text);
};

export default {
  name: 'notes',
  version: '1.0.0',
  description: 'A shared scratchpad: the model appends to it, the window shows it.',

  setup(ctx) {
    ctx.log('scratchpad ready');

    // The model writes `NOTE whatever it wants to remember` and gets the whole
    // pad back, so it can read what is already there before adding more.
    ctx.tools.register('NOTE', async ({ arg, body }) => {
      const text = (arg || body || '').trim();
      if (!text) return `the pad is empty. NOTE <text> adds a line.`;
      if (/^(read|show|list)$/i.test(text)) return read() || 'the pad is empty.';
      write(`${read()}${read() ? '\n' : ''}- ${text}\n`);
      return `noted. the pad now reads:\n${read()}`;
    }, { description: 'remember a line in the shared scratchpad, or read it' });

    // A panel: markup the window drops into its sidebar. It can call back into
    // the backend with rpc() to keep itself fresh.
    ctx.panel({
      id: 'notes',
      title: 'scratchpad',
      render: async () => ({
        html: `<h5>scratchpad</h5>
<ul><li>${(read() || '(empty — NOTE something in a chat)').replace(/</g, '&lt;').split('\n').filter(Boolean).join('</li><li>')}</li></ul>`,
      }),
    });

    // A method the window can call: it appears as /rpc {"method":"plugin.notes.clear"}.
    ctx.rpc.method('plugin.notes.clear', async () => { write(''); return { ok: true }; });

    ctx.settings.define({ key: 'notes.file', label: 'scratchpad file', type: 'text', default: '~/.aipass/notes.md' });
  },
};
