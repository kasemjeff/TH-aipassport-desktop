// Checkpoints feature module.
export function createCheckpoints(ctx) {
  async function refreshCheckpoints() {
    const res = await ctx.rpc('checkpoints.list').catch(() => null);
    ctx.state.checkpoints = res?.checkpoints ?? [];
    renderCheckpoints();
    return ctx.state.checkpoints;
  }

  /** The checkpoint rows. Each one says what it can bring back. */
  function renderCheckpoints() {
    const wrap = ctx.$('checkpoints');
    const list = ctx.$('checkpoint-list');
    if (!wrap || !list) return;
    const rows = ctx.state.checkpoints ?? [];
    list.textContent = '';
    ctx.$('checkpoints-count').textContent = rows.length ? `จุดย้อนกลับ ${rows.length} รายการ` : 'ไม่มีจุดย้อนกลับ';
    for (const cp of rows) {
      const li = ctx.el('li');
      const when = Number.isFinite(cp?.createdAt) ? new Date(cp.createdAt) : null;
      li.append(ctx.el('span', null, when ? when.toLocaleString() : String(cp?.id ?? '')));
      // The files are the point of a checkpoint: it names what it can bring
      // back, so the row names them too.
      const files = (cp?.files ?? [])
        .map((f) => (typeof f === 'string' ? f : f?.path))
        .filter(Boolean);
      const shown = files.slice(0, 3).join(', ');
      li.append(ctx.el('span', 'counts', files.length ? `${shown}${files.length > 3 ? ` +${files.length - 3}` : ''}` : 'ไม่มีไฟล์'));
      li.title = files.length ? files.join('\n') : '';
      li.append(ctx.el('span', 'grow'));
      const back = ctx.el('button', 'mini', 'ย้อนกลับ');
      back.title = 'ย้อนกลับไฟล์เหล่านี้ — ไฟล์จะถูกคืนค่าเหมือนก่อนเขียน';
      back.onclick = () => restoreCheckpoint(cp, files);
      const forget = ctx.el('button', 'mini', 'ลืม');
      forget.title = 'ลบจุดย้อนกลับนี้ — ไม่สามารถย้อนกลับได้อีก';
      forget.onclick = () => removeCheckpoint(cp);
      li.append(back, forget);
      list.append(li);
    }
    wrap.classList.toggle('hidden', rows.length === 0);
  }

  /** Put a checkpoint's files back as they were. */
  async function restoreCheckpoint(cp, files = []) {
    const what = files.length ? `${files.length} ไฟล์ (${files.slice(0, 3).join(', ')}${files.length > 3 ? '...' : ''})` : 'ทุกไฟล์';
    if (!window.confirm(`ย้อนกลับ ${what}? การกระทำนี้ไม่สามารถเลิกได้`)) return;
    const done = await ctx.rpc('checkpoints.restore', { id: cp.id }).catch((err) => ({ error: err.message }));
    if (done.error) { ctx.addNote(`ย้อนกลับไม่ได้: ${ctx.friendly(done.error)}`); return; }
    const restored = done.restored ?? [];
    const removed = done.removed ?? [];
    const skipped = done.skipped ?? [];
    ctx.addNote(`ย้อนกลับแล้ว — กลับมา ${restored.length} ไฟล์${removed.length ? ` · ถูกลบออก ${removed.length} ไฟล์` : ''}${skipped.length ? ` · ข้าม ${skipped.length} ไฟล์` : ''}`);
    void ctx.refreshFiles();
    await refreshCheckpoints();
  }

  /** Forget a checkpoint without restoring it. */
  async function removeCheckpoint(cp) {
    const done = await ctx.rpc('checkpoints.remove', { id: cp.id }).catch((err) => ({ error: err.message }));
    if (done.error) { ctx.addNote(`ลบไม่ได้: ${ctx.friendly(done.error)}`); return; }
    ctx.addNote('ลบจุดย้อนกลับแล้ว');
    await refreshCheckpoints();
  }

  /** The checkpoints in a dialog, for the reader who wants the whole list. */
  async function showCheckpoints() {
    await refreshCheckpoints();
    const rows = ctx.state.checkpoints ?? [];
    ctx.$('modal-title').textContent = 'จุดย้อนกลับ';
    const body = ctx.$('modal-body');
    body.textContent = '';
    if (!rows.length) {
      body.append(ctx.el('p', 'dim', 'ไม่มีจุดย้อนกลับ'));
    }
    for (const cp of rows) {
      const files = (cp?.files ?? []).map((f) => (typeof f === 'string' ? f : f?.path)).filter(Boolean);
      const when = Number.isFinite(cp?.createdAt) ? new Date(cp.createdAt) : null;
      const row = ctx.el('div', 'session-row');
      row.append(ctx.el('span', 'name', when ? when.toLocaleString() : String(cp?.id ?? '')));
      row.append(ctx.el('span', 'dim', files.join(', ')));
      const back = ctx.el('button', 'mini', 'ย้อนกลับ');
      back.onclick = async () => { ctx.hideModal(); await restoreCheckpoint(cp, files); };
      const forget = ctx.el('button', 'mini', 'ลืม');
      forget.onclick = async () => { await removeCheckpoint(cp); await showCheckpoints(); };
      row.append(back, forget);
      body.append(row);
    }
    ctx.$('modal-actions').textContent = '';
    const close = ctx.el('button', 'primary', 'ปิด');
    close.onclick = ctx.hideModal;
    ctx.$('modal-actions').append(close);
    ctx.openModal();
  }

  return { refreshCheckpoints, renderCheckpoints, restoreCheckpoint, removeCheckpoint, showCheckpoints };
}