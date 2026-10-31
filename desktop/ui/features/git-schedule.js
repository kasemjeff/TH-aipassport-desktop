// The git + schedule feature module (extracted from app.js).
export function createGitSchedule(ctx) {
  async function showGitStatus() {
    const st = await ctx.rpc('git.status').catch(() => null);
    if (!st) { ctx.addNote('git ไม่พร้อม — ตรวจ git status ไม่ได้'); return; }
    ctx.state.git = st;
    ctx.addCommandOut(`git: ${st.branch ?? '(ไม่มี branch)'}${st.clean ? ' · clean' : ''}`);
    for (const [label, rows] of [['staged', st.staged], ['unstaged', st.unstaged], ['untracked', st.untracked]]) {
      const list = rows ?? [];
      ctx.addCommandOut(`${label}: ${list.length ? list.join(', ') : '(ว่าง)'}`);
    }
  }

  const folderName = (root) => String(root ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(root ?? '');

  async function showSchedule() {
    const res = await ctx.rpc('schedule.list').catch((err) => ({ error: err.message }));
    if (res?.error) { ctx.addNote(`อ่านตารางเวลาไม่ได้: ${ctx.friendly(res.error)}`); return; }
    const entries = res?.entries ?? [];
    ctx.state.schedule = entries;
    if (!entries.length) { ctx.addCommandOut('ไม่มีงานที่ตั้งเวลาไว้ — ตั้งใน /settings'); return; }
    ctx.addCommandOut(`งานที่ตั้งเวลา ${entries.length} รายการ:`);
    for (const e of entries) {
      ctx.addCommandOut(`  ${e.at ?? '?'} · ${e.kind === 'once' ? 'ครั้งเดียว' : 'ทุกวัน'} · ${e.task} — ${folderName(e.root)}`);
    }
  }

  return { showGitStatus, showSchedule };
}