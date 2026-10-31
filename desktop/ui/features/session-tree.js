// Session tree + export feature module.
export function createSessionTree(ctx) {
function exportSession(id = null, title = null) {
  const sessionId = id ?? ctx.state.sessionId;
  if (!sessionId) { ctx.addNote('ยังไม่มีบทสนทนาที่จะส่งออก — เปิดบทสนทนาก่อน'); return; }
  ctx.$('modal-title').textContent = 'ส่งออกบทสนทนา';
  const body = ctx.$('modal-body');
  body.textContent = '';
  const group = ctx.el('div', 'set-group');
  const form = ctx.el('div', 'set-group');

  const format = document.createElement('select');
  for (const [v, text] of [['md', 'Markdown (.md)'], ['html', 'HTML (.html)']]) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = text;
    format.append(opt);
  }
  // The default is named rather than implied: a select with no value is a
  // select the backend refuses.
  format.value = 'md';
  // Both controls carry a name for a screen reader: the row's label is a
  // sibling, not a <label>, and a placeholder is not a name.
  format.setAttribute('aria-label', 'รูปแบบไฟล์ที่จะส่งออก');
  const path = document.createElement('input');
  path.type = 'text';
  path.value = `exports/session-${sessionId}.md`;
  path.title = 'ทางของไฟล์ — ถ้าไม่ขึ้นต้นด้วย / หรือ C:\\ ถือว่าอยู่ในโปรเจกต์นี้';
  path.setAttribute('aria-label', 'ทางของไฟล์ที่จะส่งออก');
  // The extension follows the shape: a file named .md that holds HTML is a
  // file nobody can open the way they expect.
  format.onchange = () => {
    const wanted = format.value === 'html' ? '.html' : '.md';
    path.value = path.value.replace(/\.(md|html)$/i, '') + wanted;
  };
  const row = (label, note, node) => {
    const r = ctx.el('div', 'set-row');
    const info = ctx.el('div', 'set-info');
    info.append(ctx.el('div', 'set-title', label));
    if (note) info.append(ctx.el('div', 'set-note', note));
    const c = ctx.el('div', 'set-control');
    c.append(node);
    r.append(info, c);
    return r;
  };
  form.append(row('รูปแบบ', 'markdown อ่านต่อได้ทุกเครื่อง · HTML เปิดในเบราว์เซอร์ได้เลย', format));
  form.append(row('ทางของไฟล์', 'เขียนลงโปรเจกต์นี้ (ใส่ทางเต็มก็ได้)', path));
  group.append(ctx.el('p', 'settings-empty', title ? `บทสนทนา: ${title}` : `บทสนทนา #${sessionId}`), form);
  body.append(group);

  const actions = ctx.$('modal-actions');
  actions.textContent = '';
  const save = ctx.el('button', 'primary', 'ส่งออก');
  save.onclick = async () => {
    save.disabled = true;
    const done = await ctx.rpc('session.export', {
      id: sessionId,
      format: format.value,
      path: path.value.trim(),
    }).catch((err) => ({ error: err.message }));
    save.disabled = false;
    if (done.error) {
      const err = ctx.el('p', 'install-out err', `ส่งออกไม่ได้: ${ctx.friendly(done.error)}`);
      body.append(err);
      return;
    }
    // Without a path the backend answers with the text itself, so the reader
    // can see what would be written before it is written.
    if (!done.path) {
      body.textContent = '';
      body.append(ctx.el('p', 'dim', 'ใส่ทางของไฟล์เพื่อให้เขียนลงดิสก์ — นี่คือเนื้อหาที่จะได้:'));
      body.append(ctx.el('pre', null, done.text ?? ''));
      return;
    }
    ctx.hideModal();
    ctx.addCommandOut(`ส่งออกแล้ว: ${done.path}`);
  };
  const close = ctx.el('button', null, 'ปิด');
  close.onclick = ctx.hideModal;
  actions.append(close, save);
  ctx.openModal();
}

/* ------------------------------------------------------------------- tree */

/** The day a tree row falls in, read as a local day (never a UTC one). */
const dayKeyDate = (key) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(key ?? ''));
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};

/**
 * The sessions of this project, grouped by the day they belong to.
 *
 * The same grouping the rail uses, but as data (session.tree): the tree and
 * the rail cannot disagree about where a session sits, because both read the
 * same store.
 */
async function showSessionTree() {
  const res = await ctx.rpc('session.tree').catch(() => null);
  if (!res) { ctx.addNote('อ่านต้นไม้บทสนทนาไม่ได้'); return; }
  ctx.$('modal-title').textContent = 'ต้นไม้บทสนทนา';
  const body = ctx.$('modal-body');
  body.textContent = '';
  const days = res.days ?? [];
  body.append(ctx.el('p', 'dim', `${res.count ?? 0} บทสนทนาในโปรเจกต์นี้`));
  if (!days.length) body.append(ctx.el('p', 'dim', 'ยังไม่มีบทสนทนาในโปรเจกต์นี้'));
  for (const day of days) {
    const when = dayKeyDate(day.day);
    body.append(ctx.el('h4', null, when ? `${ctx.sessionDay(when)} · ${day.day}` : String(day.day ?? '')));
    for (const s of day.sessions ?? []) {
      const row = ctx.el('div', 'session-row');
      const open = ctx.el('button', null, s.title || '(ไม่มีชื่อ)');
      open.onclick = () => { ctx.hideModal(); void ctx.openSession(s.id); };
      row.append(open);
      row.append(ctx.el('span', 'dim', `${s.entryCount ?? 0} รายการ`));
      const out = ctx.el('button', 'mini', 'ส่งออก');
      out.onclick = () => { ctx.hideModal(); ctx.exportSession(s.id, s.title); };
      row.append(out);
      body.append(row);
    }
  }
  ctx.$('modal-actions').textContent = '';
  const close = ctx.el('button', 'primary', 'ปิด');
  close.onclick = ctx.hideModal;
  ctx.$('modal-actions').append(close);
  ctx.openModal();
}

  return { exportSession, showSessionTree };
}
