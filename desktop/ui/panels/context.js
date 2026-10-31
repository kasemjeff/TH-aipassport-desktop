// The right-hand "Session" panel: what the run is spending, where it is, and
// what the project carries. Every row is real aipass data; rows with no
// backing RPC are simply not rendered.

export function createContextPanel(ctx) {
  const { $, el, state, rpc, openSettings, addNote } = ctx;

  const row = (label, value, opts = {}) => {
    const r = el('div', 'cp-row' + (opts.clickable ? ' clickable' : ''));
    const l = el('div', 'cp-label', label);
    const v = el('div', 'cp-value', value == null ? '—' : String(value));
    r.append(l, v);
    if (opts.bar != null) {
      const b = el('div', 'cp-bar');
      const s = el('span');
      s.style.width = Math.max(0, Math.min(100, opts.bar)) + '%';
      b.append(s);
      r.append(b);
    }
    if (opts.onClick) r.onclick = opts.onClick;
    return r;
  };

  const section = (title) => el('div', 'cp-section', title);

  async function refresh() {
    const panel = $('context-panel');
    if (!panel) return;
    const [st, credits, git, wt, mem, skills, mcp] = await Promise.all([
      rpc('status').catch(() => null),
      rpc('credits').catch(() => null),
      rpc('git.status').catch(() => null),
      rpc('worktree.status').catch(() => null),
      rpc('memory.list').catch(() => null),
      rpc('skills.list').catch(() => null),
      rpc('mcp.list').catch(() => null),
    ]);

    panel.textContent = '';
    panel.append(el('h3', null, 'Session'));

    // Context
    const c = st?.context;
    if (c) {
      panel.append(section('Context'));
      panel.append(row('Usage', `${c.percent ?? 0}%`, { bar: c.percent ?? 0 }));
      panel.append(row('Tokens', `${(c.used ?? 0).toLocaleString()} / ${(c.budget ?? 0).toLocaleString()}`));
    }

    // Credits
    if (credits) {
      panel.append(section('Credits'));
      panel.append(row('Available', `${credits.available ?? 0} / ${credits.limit ?? 0}`));
    }

    // Project / branch
    panel.append(section('Project'));
    panel.append(row('Root', (st?.root ?? '').split(/[\\/]/).slice(-2).join('/') || '—'));
    if (git?.branch) panel.append(row('Branch', git.branch + (git.clean ? '  (clean)' : '  (dirty)')));
    if (wt?.branch) panel.append(row('Worktree', wt.branch + (wt.clean ? '  (clean)' : `  (${(wt.files ?? []).length} files)`)));

    // Memory
    const facts = Array.isArray(mem?.facts) ? mem.facts : (Array.isArray(mem) ? mem : []);
    panel.append(section('Memory'));
    panel.append(row('Facts', facts.length, { clickable: true, onClick: () => openSettings && openSettings('memory') }));

    // Skills
    const sk = Array.isArray(skills) ? skills : (skills?.skills ?? []);
    panel.append(row('Skills', sk.length, { clickable: true, onClick: () => openSettings && openSettings('skills') }));

    // MCP
    const servers = Array.isArray(mcp?.servers) ? mcp.servers : [];
    panel.append(section('MCP'));
    panel.append(row('Servers', servers.length, { clickable: true, onClick: () => openSettings && openSettings('mcp') }));
    for (const s of servers.slice(0, 6)) {
      const r = el('div', 'cp-mcp');
      r.append(el('span', null, `${s.enabled ? '●' : '○'} ${s.name ?? s.id ?? '?'}`));
      const btn = el('button', null, s.enabled ? 'off' : 'on');
      btn.onclick = async () => {
        const verb = s.enabled ? 'disable' : 'enable';
        const method = 'mcp.' + verb;
        try { await rpc(method, { name: s.name ?? s.id, scope: s.scope }); await refresh(); }
        catch (e) { addNote && addNote(String(e?.message ?? e)); }
      };
      r.append(btn);
      panel.append(r);
    }

    // Index
    try {
      const idx = await rpc('retrieval.status').catch(() => null);
      if (idx && !idx.error) {
        panel.append(section('Index'));
        const age = idx.builtAt ? Math.max(0, Math.round((Date.now() - idx.builtAt) / 1000)) + 's old' : 'not built';
        panel.append(row('Files', idx.files ?? 0));
        panel.append(row('Passages', idx.chunks ?? 0));
        panel.append(row('Age', age));
        panel.append(row('Clear', 'x', { clickable: true, onClick: async () => {
          try { await rpc('retrieval.clear'); await refresh(); }
          catch (e) { addNote && addNote(String(e?.message ?? e)); }
        } }));
      }
    } catch {}

    // Session
    const sess = st?.session;
    if (sess) {
      panel.append(section('Session'));
      panel.append(row('Title', sess.title ?? sess.id));
      panel.append(row('Entries', sess.entryCount ?? sess.entries ?? 0));
      panel.append(row('Model', sess.model ?? st?.model ?? ''));
    }
  }

  return { refresh, render: refresh };
}
