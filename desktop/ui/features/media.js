// The media feature module (extracted from app.js).
export function createMedia(ctx) {
  async function showMediaModels() {
    const res = await ctx.rpc('media.models').catch(() => null);
    if (!res) { ctx.addNote('อ่านรายการโมเดลสื่อไม่ได้ — ต้องมี bridge ที่เชื่อมอยู่'); return; }
    ctx.state.media = res;
    for (const [kind, label] of [['image', 'รูป'], ['video', 'วิดีโอ'], ['music', 'เสียง']]) {
      const list = res[kind] ?? [];
      ctx.addCommandOut(`${label}: ${list.length} โมเดล${list.length ? ` — ${list.map((m) => m.id).join(', ')}` : ''}`);
    }
  }
  return { showMediaModels };
}
