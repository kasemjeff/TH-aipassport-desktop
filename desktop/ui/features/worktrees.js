// The worktrees feature module (extracted from app.js).
// Owns the second-checkout surface: list, enter, leave, remove, render bar.
// All shared state lives on ctx; nothing is module-global.

export function createWorktrees(ctx) {
/* -------------------------------------------------------------- worktrees */

/**
 * The worktrees of this project — the second checkouts a run can work in.
 *
 * A worktree is git's answer to two runs (or a run and the person) editing
 * one repository: "if two Cascades edit the same file at the same time, the
 * edits can race … consider using worktrees" (Devin). The run's files are
 * then not the person's files, and the person merges the branch when they are
 * happy or throws the folder away when they are not.
 *
 * The window says what a worktree is, where it lives, and what changed in
 * each one: a person who cannot find the folder cannot merge it.
 */
async function showWorktrees() {
  const res = await ctx.rpc('worktree.list').catch((err) => ({ error: err.message }));
  const list = res?.worktrees ?? [];
  ctx.state.worktrees = list;

  ctx.$('modal-title').textContent = 'worktree';
  const body = ctx.$('modal-body');
  body.textContent = '';
  if (res?.error) body.append(ctx.el('p', 'install-out err', ctx.friendly(res.error)));
  body.append(ctx.el('p', 'dim',
    'worktree คือโฟลเดอร์สำเนาของ repo อีกชุดหนึ่ง — รันในนั้นแล้วไฟล์ที่แก้จะไม่ไปแตะไฟล์ที่คุณกำลังแก้อยู่ เสร็จแล้วค่อย merge กลับ branch หรือทิ้งทิ้งไป'));
  body.append(ctx.el('p', 'dim', `ที่อยู่: ${res?.home ?? '(ไม่ทราบ)'} — นอกโปรเจกต์ เพื่อไม่ให้ git add -A ไปเจอ`));

  const group = ctx.el('div', 'set-group');
  body.append(group);
  if (!list.length) group.append(ctx.el('p', 'settings-empty', 'ยังไม่มี worktree ของโปรเจกต์นี้'));

  for (const w of list) {
    const box = ctx.el('div', 'set-group');
    const info = ctx.el('div', 'set-info');
    info.append(ctx.el('div', 'set-title', w.main ? 'โปรเจกต์นี้เอง' : (w.branch ?? '(ไม่มี branch)')));
    // The path, in full: it is the one thing the person needs and cannot
    // guess — the folder is somewhere else on the disk, not under the project.
    info.append(ctx.el('div', 'set-note', w.path));
    box.append(info);
    if (!w.main) {
      // What changed in there: the person decides with this, not with the
      // name of the folder.
      const st = await ctx.rpc('worktree.status', { path: w.path }).catch(() => null);
      const files = st?.files ?? [];
      info.append(ctx.el('div', 'set-note', files.length
        ? `เปลี่ยน ${files.length} ไฟล์ (+${st.added ?? 0} −${st.removed ?? 0}) · ${files.slice(0, 4).join(', ')}${files.length > 4 ? '…' : ''}`
        : 'ยังไม่มีอะไรเปลี่ยนในนี้'));
      const row = ctx.el('div', 'wt-actions');
      const sameProject = (a, b) => String(a).replace(/\\/g, '/').toLowerCase() === String(b).replace(/\\/g, '/').toLowerCase();
      const enter = ctx.el('button', 'mini', ctx.state.runRoot && sameProject(ctx.state.runRoot, w.path) ? 'กำลังทำงานในนี้' : 'ทำงานในนี้');
      enter.onclick = async () => { await enterWorktree(w.path); await showWorktrees(); };
      const drop = ctx.el('button', 'mini', 'ลบ');
      drop.onclick = async () => { await removeWorktree(w.path); await showWorktrees(); };
      row.append(enter, drop);
      box.append(row);
    }
    group.append(box);
  }

  // The new one. The name becomes the folder's name, so it is the person's
  // own word — Thai is fine, the folder is named after it.
  const name = document.createElement('input');
  name.type = 'text';
  name.placeholder = 'ชื่อ worktree — เช่น ทดลองแนวคิดใหม่';
  // The field is named, not only hinted: a placeholder is not a name a
  // screen reader reads.
  name.setAttribute('aria-label', 'ชื่อ worktree ใหม่');
  const make = ctx.el('button', 'primary', 'สร้าง worktree');
  make.onclick = async () => {
    const text = name.value.trim();
    if (!text) { ctx.addNote('ต้องตั้งชื่อ worktree ก่อน'); return; }
    make.disabled = true;
    const made = await ctx.rpc('worktree.create', { name: text }).catch((err) => ({ error: err.message }));
    make.disabled = false;
    if (made.error) { ctx.addNote(`สร้าง worktree ไม่สำเร็จ: ${ctx.friendly(made.error)}`); return; }
    await enterWorktree(made.path);
    await showWorktrees();
  };
  const form = ctx.el('div', 'set-group');
  form.append(ctx.el('div', 'set-title', 'สร้าง worktree ใหม่'));
  form.append(ctx.el('div', 'set-note', 'รันต่อจากนี้จะทำในโฟลเดอร์นี้ ไฟล์ในโปรเจกต์จะไม่ถูกแตะ'));
  form.append(name, make);
  body.append(form);

  const actions = ctx.$('modal-actions');
  actions.textContent = '';
  // The janitor: a worktree is a whole checkout on the person's disk, so a
  // forgotten one is litter. Only the ones with nothing uncommitted in them
  // and the ones that have sat there for a while go.
  const sweep = ctx.el('button', null, 'เก็บกวาดที่ไม่ต้องการแล้ว');
  sweep.onclick = async () => {
    const done = await ctx.rpc('worktree.sweep').catch((err) => ({ error: err.message }));
    if (done.error) { ctx.addNote(`เก็บกวาดไม่สำเร็จ: ${ctx.friendly(done.error)}`); return; }
    ctx.addNote(done.removed?.length
      ? `เก็บกวาดไป ${done.removed.length} worktree — branch ยังอยู่ใน repo ถ้าต้องการเอากลับ`
      : 'ไม่มี worktree ที่เก็บกวาดได้ (ที่ยังมีงานค้าง หรือยังใหม่อยู่ จะไม่ถูกแตะ)');
    await showWorktrees();
  };
  const close = ctx.el('button', 'primary', 'ปิด');
  close.onclick = ctx.hideModal;
  actions.append(sweep, close);
  ctx.openModal();
}

/**
 * Work inside a worktree from now on.
 *
 * The run's root becomes the worktree's path, so the harness confines every
 * tool to it and the overlay writes there: the person's own files are not
 * touched. The project stays the project, so leaving the worktree is one
 * click.
 */
/**
 * A live run is tied to the root it started in.
 *
 * Changing the root under it would make the run's frames belong to a folder
 * the window no longer claims, and the window would go quiet for the rest of
 * the run. So the switch waits for the run to end.
 */
function worktreeLocked() {
  if (!ctx.state.running) return false;
  ctx.addNote('รันอยู่ — สลับหรือลบ worktree ระหว่างรันไม่ได้ หยุดรันก่อน');
  return true;
}

async function enterWorktree(path) {
  if (worktreeLocked()) return;
  ctx.state.runRoot = path;
  renderWorktreeBar();
  await Promise.all([ctx.refreshSessions(), ctx.refreshFiles('.'), ctx.refreshPending(), ctx.refreshCheckpoints()]);
  ctx.addNote(`รันต่อจากนี้ทำใน worktree: ${path}`);
}

/** Back to the project the worktree was made from. */
async function leaveWorktree() {
  if (worktreeLocked()) return;
  ctx.state.runRoot = null;
  renderWorktreeBar();
  await Promise.all([ctx.refreshSessions(), ctx.refreshFiles('.'), ctx.refreshPending(), ctx.refreshCheckpoints()]);
  ctx.addNote('กลับไปทำงานในโปรเจกต์แล้ว');
}

/**
 * Take a worktree away.
 *
 * The window asks first: an uncommitted file inside a worktree exists
 * nowhere else, and the branch keeps the COMMITS but not those bytes.
 */
async function removeWorktree(path) {
  if (worktreeLocked()) return;
  const st = await ctx.rpc('worktree.status', { path }).catch(() => null);
  const files = st?.files ?? [];
  const ask = files.length
    ? `ลบ worktree นี้? — ยังมี ${files.length} ไฟล์ที่ไม่ได้ merge การลบจะทำให้ไฟล์เหล่านั้นหายไป`
    : 'ลบ worktree นี้? — โฟลเดอร์จะถูกลบออกจากเครื่อง (branch ยังอยู่ใน repo)';
  if (!window.confirm(ask)) return;
  const done = await ctx.rpc('worktree.remove', { path, force: true }).catch((err) => ({ error: err.message }));
  if (done.error) { ctx.addNote(`ลบ worktree ไม่ได้: ${ctx.friendly(done.error)}`); return; }
  const sameProject2 = (a, b) => String(a).replace(/\\/g, '/').toLowerCase() === String(b).replace(/\\/g, '/').toLowerCase();
  if (ctx.state.runRoot && sameProject2(ctx.state.runRoot, path)) await leaveWorktree();
  ctx.addNote('ลบ worktree แล้ว — branch ยังอยู่ใน repo ถ้าต้องการเอากลับ');
}

/**
 * The bar that says where the run works.
 *
 * It is on screen the whole time the window is in a worktree, and it carries
 * the PATH: the folder is somewhere else on the disk, and a person who cannot
 * find it cannot merge it.
 */
function renderWorktreeBar() {
  const bar = ctx.$('worktree-bar');
  if (!bar) return;
  const on = Boolean(ctx.state.runRoot);
  bar.classList.toggle('hidden', !on);
  if (on) ctx.$('worktree-path').textContent = ctx.state.runRoot;
}
ctx.$('worktree-list').onclick = () => { void showWorktrees(); };
ctx.$('worktree-back').onclick = () => { void leaveWorktree(); };
// The bar's state is the window's state, so it is painted once here: a
// window that is not in a worktree shows no bar at all.
renderWorktreeBar();


  return { showWorktrees, enterWorktree, leaveWorktree, removeWorktree, renderWorktreeBar, worktreeLocked };
}

