// The pending-diff feature module (apply/discard).
export function createPending(ctx) {
  let applyInFlight = false;

  async function showPendingDiff() {
    const pending = await ctx.rpc('pending').catch(() => []);
    if (!pending.length) { ctx.addNote('ไม่มีไฟล์รอเขียน'); return; }
    await ctx.showDiff(pending[0].file);
  }

  async function applyChecked() {
    if (applyInFlight) return;
    applyInFlight = true;
    try {
      const files = [...ctx.state.pending.entries()].filter(([, info]) => info.checked).map(([file]) => file);
      if (!files.length) { ctx.addNote('ยังไม่มีไฟล์ที่ติ๊ก'); return; }
      const written = await ctx.rpc('apply', { files }).catch((err) => ({ error: err.message }));
      if (written.error) { ctx.addNote(`เขียนไฟล์ไม่ได้: ${ctx.friendly(written.error)}`); return; }
      await ctx.refreshPending();
      await ctx.refreshCheckpoints();
      if (written.checkpoint?.id) ctx.addNote(`เขียนแล้ว — ย้อนกลับได้ที่จุด #${written.checkpoint.id}`);
    } finally {
      applyInFlight = false;
    }
  }

  async function discardAll() {
    if (applyInFlight) return;
    applyInFlight = true;
    try {
      const dropped = await ctx.rpc('discard').catch((err) => ({ error: err.message }));
      if (dropped.error) { ctx.addNote(`ทิ้งไฟล์ไม่ได้: ${ctx.friendly(dropped.error)}`); return; }
      await ctx.refreshPending();
    } finally {
      applyInFlight = false;
    }
  }

  return { showPendingDiff, applyChecked, discardAll };
}