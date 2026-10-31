// Misc command handlers (memory, goal, mcp, symbols, index).
export function createMiscCommands(ctx) {
async function showMemory(arg) {
  if (arg && arg.trim().toLowerCase() === 'clear') {
    await ctx.rpc('memory.clear').catch(() => {});
    ctx.addCommandOut('ลืม facts ข้าม session ทั้งหมดแล้ว');
    return;
  }
  const res = await ctx.rpc('memory.list').catch(() => null);
  const facts = res?.facts ?? [];
  if (!facts.length) { ctx.addCommandOut('(ยังไม่มี facts ข้าม session — รัน /compact หรือให้ agent ทำงานสักพัก)'); return; }
  ctx.addCommandOut(`facts ข้าม session ${facts.length} รายการ:`);
  for (const f of facts) ctx.addCommandOut(`  - ${f}`);
  ctx.addCommandOut('ลืมทั้งหมด: /memory clear');
}

/**
 * The project's one goal, in the window: reading it and the verbs that move it
 * are the same ones `aipass goal` accepts, so the composer and the terminal
 * cannot disagree. The settings sheet has the form.
 */
async function showGoal(arg) {
  const [verb = 'show', ...rest] = String(arg ?? '').trim().split(/\s+/).filter(Boolean);
  const text = rest.join(' ').trim();
  try {
    if (verb === 'show' || verb === 'list') {
      const { goal } = await ctx.rpc('goal.get');
      if (!goal) { ctx.addCommandOut('โปรเจกต์นี้ยังไม่มีเป้าหมาย — /goal set "<สิ่งที่อยากทำให้เสร็จ>"'); return; }
      ctx.addCommandOut(`เป้าหมาย (${goal.status}): ${goal.objective}`);
      ctx.addCommandOut(`  รอบ ${goal.rounds}/${goal.maxRounds}`);
      if (goal.blocked) ctx.addCommandOut(`  ติด: ${goal.blocked}`);
      if (goal.done) ctx.addCommandOut(`  เสร็จ: ${goal.done}`);
      return;
    }
    if (verb === 'set') {
      if (!text) { ctx.addCommandOut('ใส่เป้าหมายด้วย: /goal set "<สิ่งที่อยากทำให้เสร็จ>"'); return; }
      const { goal } = await ctx.rpc('goal.set', { objective: text });
      ctx.addCommandOut(`ตั้งเป้าหมายแล้ว (รอบ 1-${goal.maxRounds}): ${goal.objective}`);
      return;
    }
    if (verb === 'pause') { const { goal } = await ctx.rpc('goal.pause'); ctx.addCommandOut(`พักเป้าหมายแล้ว: ${goal.objective}`); return; }
    if (verb === 'resume') { const { goal } = await ctx.rpc('goal.resume'); ctx.addCommandOut(`ทำเป้าหมายต่อ (รอบ 1-${goal.maxRounds}): ${goal.objective}`); return; }
    if (verb === 'done') { const { goal } = await ctx.rpc('goal.done', { done: text }); ctx.addCommandOut(`ปิดเป้าหมายแล้ว: ${goal.objective}${goal.done ? ` — ${goal.done}` : ''}`); return; }
    if (verb === 'block') { const { goal } = await ctx.rpc('goal.block', { reason: text }); ctx.addCommandOut(`บันทึกว่าเป้าหมายติด: ${goal.blocked}`); return; }
    if (verb === 'clear') { await ctx.rpc('goal.clear'); ctx.addCommandOut('ลบเป้าหมายของโปรเจกต์นี้แล้ว'); return; }
    ctx.addCommandOut('ใช้: /goal [set "<ข้อความ>"|pause|resume|done [ข้อความ]|block [เหตุผล]|clear]');
  } catch (err) {
    ctx.addCommandOut(`goal: ${ctx.friendly(err.message)}`);
  }
}

async function showMcp() {
  const res = await ctx.rpc('mcp.list').catch(() => null);
  if (!res) { ctx.addCommandOut('bridge ไม่ตอบ'); return; }
  const servers = res.servers ?? [];
  if (!servers.length) { ctx.addCommandOut('(ยังไม่มี MCP server — เพิ่มที่ /settings → MCP หรือ `aipass mcp add`)'); return; }
  ctx.addCommandOut(`MCP: ${servers.length} server · ${(res.tools ?? []).length} tool:`);
  for (const s of servers) {
    const state = !s.enabled ? 'ปิด' : s.connected ? `เชื่อมต่อแล้ว ${s.tools} tools` : `เชื่อมต่อไม่ได้: ${s.error ?? '?'}`;
    ctx.addCommandOut(`  ${s.name} [${s.scope}] — ${state}${s.risk === 'read' ? '' : ' · เขียน'}`);
  }
  for (const t of res.tools ?? []) ctx.addCommandOut(`      ${t.marker}  ${t.description}`);
}

/**
 * The code-navigation index, from the window instead of from a run.
 *
 * `/symbols <file>` lists what a file declares; `/symbols <name>` says where
 * a name is defined and where it is used. It is the same index the SYMBOLS,
 * DEF and REFS markers use — the markers are for the model, this is for the
 * person reading the window.
 */
async function showSymbols(arg) {
  const what = (arg || '').trim();
  if (!what) {
    ctx.addCommandOut('usage: /symbols <file>  — declarations ของไฟล์ · /symbols <name> — ที่ที่มันถูกนิยามและใช้');
    return;
  }
  const asFile = await ctx.rpc('symbols.list', { file: what }).catch((err) => ({ error: err.message }));
  if (asFile.error) { ctx.addCommandOut(`symbols: ${ctx.friendly(asFile.error)}`); return; }
  if (asFile.symbols?.length) {
    ctx.addCommandOut(`${asFile.file} — ${asFile.symbols.length} ตัว:`);
    for (const s of asFile.symbols.slice(0, 80)) ctx.addCommandOut(`  ${s.line}: ${s.kind} ${s.name}`);
    return;
  }
  // Not a file, or a file with no declarations in it: try it as a name.
  const def = await ctx.rpc('symbols.def', { name: what }).catch((err) => ({ error: err.message }));
  if (def.error) { ctx.addCommandOut(`symbols: ${ctx.friendly(def.error)}`); return; }
  if (!def.definitions?.length) {
    ctx.addCommandOut(`ไม่พบ "${what}" — ไม่ใช่ไฟล์ที่มี declarations และไม่ใช่ชื่อที่ถูกนิยามในโปรเจกต์นี้`);
    return;
  }
  ctx.addCommandOut(`${what} — ถูกนิยามไว้ที่:`);
  for (const d of def.definitions) ctx.addCommandOut(`  ${d.file}:${d.line}  ${d.kind} ${d.name}`);
  const refs = await ctx.rpc('symbols.refs', { name: what }).catch(() => null);
  const used = refs?.references ?? [];
  if (used.length) {
    ctx.addCommandOut(`ใช้ที่ ${used.length} ที่:`);
    for (const r of used.slice(0, 40)) ctx.addCommandOut(`  ${r.file}:${r.line}  ${r.snippet}`);
  }
}

async function showIndex(arg) {
  const verb = String(arg || "").trim().toLowerCase();
  if (verb === "clear") {
    const res = await ctx.rpc("retrieval.clear").catch(function(err){ return { error: err.message }; });
    if (res && res.error) { ctx.addCommandOut("index: " + ctx.friendly(res.error)); return; }
    ctx.addCommandOut("ลบ index แล้ว — จะสร้างใหม่ตอน RETRIEVE ครั้งถัดไป");
    return;
  }
  const st = await ctx.rpc("retrieval.status").catch(function(err){ return { error: err.message }; });
  if (st && st.error) { ctx.addCommandOut("index: " + ctx.friendly(st.error)); return; }
  ctx.addCommandOut("index: " + (st.files ?? 0) + " ไฟล์ · " + (st.chunks ?? 0) + " ช่วงข้อความ · " + Math.round((st.bytes || 0) / 1024) + " KB");
}
  return { showMemory, showGoal, showMcp, showSymbols, showIndex };
}
