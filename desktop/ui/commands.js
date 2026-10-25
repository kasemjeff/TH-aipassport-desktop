// The commands: everything the app can be told to do, and the palette
// that lists them.
//
// Every command the app has is reachable by typing "/". The header carries
// three controls and the rest live here — nothing important is hidden behind
// a menu you have to guess at, and the list itself explains what the app
// does.
//
// The palette and the handlers live together because a command IS its handler:
// the entry in the list names the work, and the work is right below it.


/**
 * The commands: the palette and the handlers behind it.
 *
 * @param {object} ctx the window it draws into
 */
export function createCommands(ctx) {
  const { $, el, state, rpc, friendly, scrollDown, addNote, addCommandOut, paintCacheStats, hideModal, openModal, fillModels, refreshModels, fillProviders, refreshHeader, refreshMeta, checkForUpdate, openHelp, openSettings, showMemory, showMcp, showSymbols, listModels, pickConversation, freshConversation, attachPath, clipPaste, startNewSession, resumeSession, forkSession, togglePlan, showSkills, showPendingDiff, applyChecked, discardAll, pickProject, openFile, pickFile, setWorking, cancelRun, showCheckpoints, exportSession, showSessionTree, showGitStatus, showSchedule, showMediaModels, showWorktrees } = ctx;


/* Every command the app has, reachable by typing "/". The header carries three
 * controls and the rest live here — nothing important is hidden behind a menu
 * you have to guess at, and the list itself explains what the app does. */
const COMMANDS = [
  { cmd: 'help', desc: 'วิธีใช้ทั้งหมด', run: openHelp },
  { cmd: 'model', desc: 'เปลี่ยนโมเดล — /model หรือ /model <id>', args: true, run: (arg) => (arg ? setModel(arg) : pickModel()) },
  { cmd: 'provider', desc: 'สลับผู้ให้บริการ — /provider หรือ /provider <id>', args: true, run: (arg) => (arg ? setProvider(arg) : pickProvider()) },
  { cmd: 'models', desc: 'ดูรายการโมเดลที่ใช้คุยได้', run: listModels },
  { cmd: 'mode', desc: 'โหมดการทำงาน — /mode ask|auto|yolo|plan', args: true, run: (arg) => (arg ? setMode(arg) : pickMode()) },
  { cmd: 'status', desc: 'สถานะ bridge / extension / tab / credits', run: showStatus },
  { cmd: 'update', desc: 'เช็กและติดตั้งเวอร์ชันใหม่ — /update', run: () => checkForUpdate({ force: true, quiet: false }) },
  { cmd: 'paint', desc: 'สถิติ paint cache ของการสตรีม — hit/miss ต่อเฟรม', run: showPaintStats },
  { cmd: 'conversations', desc: 'เลือกบทสนทนาของ bridge (ความจำของโมเดล)', run: pickConversation },
  { cmd: 'fresh', desc: 'เริ่มบทสนทนาบน bridge ใหม่ (ความจำ wiped)', run: freshConversation },
  { cmd: 'compact', desc: 'บีบบริบททันที (สรุปงานเก่าแล้วเริ่ม conversation ใหม่)', run: compactNow },
  { cmd: 'memory', desc: 'ดู facts ที่จำข้าม session — /memory clear ลืมทั้งหมด', args: true, run: (arg) => showMemory(arg) },
  { cmd: 'mcp', desc: 'ดู servers/tools จาก MCP (จัดการที่ /settings → MCP)', run: showMcp },
  { cmd: 'symbols', desc: 'ดู declarations ของไฟล์ หรือที่ที่ชื่อถูกนิยาม — /symbols <file|name>', args: true, run: (arg) => showSymbols(arg) },
  { cmd: 'new', desc: 'เริ่มบทสนทนาใหม่ในหน้าต่าง', run: startNewSession },
  { cmd: 'resume', desc: 'เปิดบทสนทนาเดิม', run: resumeSession },
  { cmd: 'fork', desc: 'แยกบทสนทนาจุดนี้ไปแก้ต่อแยก', run: forkSession },
  { cmd: 'plan', desc: 'เปิด/ปิด plan mode (ร่างแผนให้อนุมัติก่อนทำ)', run: togglePlan },
  { cmd: 'attach', desc: 'แนบรูป เอกสาร หรือวิดีโอ', run: () => $('file-picker').click() },
  { cmd: 'clip', desc: 'แนบจากคลิปบอร์ด (เช่น screenshot ที่ Ctrl+V)', run: clipPaste },
  { cmd: 'file', desc: 'แนบไฟล์จาก path — /file <path>', args: true, run: (arg) => attachPath(arg, 'file') },
  { cmd: 'image', desc: 'แนบรูปจาก path — /image <path>', args: true, run: (arg) => attachPath(arg, 'image') },
  { cmd: 'open', desc: 'เปิดดูไฟล์ — /open <path>', args: true, run: (arg) => (arg ? openFile(arg) : pickFile()) },
  { cmd: 'skills', desc: 'คู่มือ (playbook) ที่มี', run: showSkills },
  { cmd: 'diff', desc: 'ดูการเปลี่ยนแปลงที่รอเขียน', run: showPendingDiff },
  { cmd: 'apply', desc: 'เขียนไฟล์ที่อนุมัติลงดิสก์', run: applyChecked },
  { cmd: 'discard', desc: 'ทิ้งไฟล์ที่รออยู่ทั้งหมด', run: discardAll },
  // The undo of a write, the transcript as a file, and the tree of the
  // project's sessions: the three things a person asks the window for when the
  // work is done and they want to keep it, take it back, or see what there is.
  { cmd: 'checkpoints', desc: 'ดูจุดย้อนกลับของไฟล์ที่เขียนไป (ย้อนกลับได้)', run: showCheckpoints },
  { cmd: 'export', desc: 'ส่งออกบทสนทนาเป็นไฟล์ md หรือ html', run: () => exportSession() },
  { cmd: 'tree', desc: 'ดูต้นไม้บทสนทนาของโปรเจกต์ (จัดกลุ่มตามวัน)', run: showSessionTree },
  { cmd: 'git', desc: 'ดูสถานะ git — stage/commit ได้ที่ /settings → git', run: showGitStatus },
  // A second checkout of the same repository: the run works in it, so the
  // files it writes are not the files the person is editing.
  { cmd: 'worktree', desc: 'worktree — โฟลเดอร์แยกสำหรับรัน (ไฟล์ไม่ไปแตะโปรเจกต์)', run: showWorktrees },
  { cmd: 'schedule', desc: 'ดูงานที่ตั้งเวลาไว้ — เพิ่ม/ลบได้ที่ /settings → ตารางเวลา', run: showSchedule },
  { cmd: 'media', desc: 'ดูโมเดลสื่อ (รูป/วิดีโอ/เสียง) — สร้างได้ที่ /settings → สร้างสื่อ', run: showMediaModels },
  { cmd: 'project', desc: 'เลือกโฟลเดอร์โปรเจกต์', run: pickProject },
  { cmd: 'settings', desc: 'ตั้งค่าทั้งหมด', run: openSettings },
  // A stop is a request with an answer: the bar says the run is winding down,
  // and the run's own end takes the bar down. The stop itself is the send
  // button's cancelRun — the one stop there is, whose guard keeps a second
  // /stop from racing the first and whose answer brings the bar back down
  // when the backend says there was nothing to stop. (This command used to
  // ask the backend by itself, and left the bar beating for a run that did
  // not exist.)
  { cmd: 'stop', desc: 'ยกเลิกรันที่กำลังทำ', run: () => cancelRun() },
];

const slash = { open: false, items: [], index: 0 };

// Mode is the one setting that decides everything else it might do — may it
// write, may it run, must it plan first — so the header select and the
// Shift+Tab cycle share one apply path. 'plan' is a view, not a permission
// mode: it means plan first, and the approval of that plan is the consent the
// run then works under, which is why its runs use 'auto'.
const MODE_VIEWS = {
  ask: { mode: 'ask', plan: false, requirePlanApproval: false },
  auto: { mode: 'auto', plan: false, requirePlanApproval: false },
  yolo: { mode: 'yolo', plan: false, requirePlanApproval: false },
  plan: { mode: 'auto', plan: true, requirePlanApproval: true },
};
const MODE_CYCLE = ['ask', 'auto', 'plan'];

const slashMatches = (value) => {
  const typed = value.slice(1).split(/\s+/)[0].toLowerCase();
  return COMMANDS.filter((c) => c.cmd.startsWith(typed));
};

// "/" opens the palette while the first word is still being typed; a space
// means an argument is being written and the palette has done its job.
const slashTyping = (value) => value.startsWith('/') && !/\s/.test(value.slice(1));

function renderSlash(value, keepSelection = false) {
  slash.items = slashMatches(value);
  // A typed word that is already a whole command selects it: "/mode" has to mean
  // /mode, not /model, even though "mode" is a prefix of "model".
  const typed = value.slice(1).split(/\s+/)[0].toLowerCase();
  const exact = slash.items.findIndex((c) => c.cmd === typed);
  slash.index = keepSelection || exact < 0 ? slash.index : exact;
  if (slash.index >= slash.items.length) slash.index = 0;
  const list = $('slash-list');
  list.textContent = '';
  slash.items.forEach((item, i) => {
    const li = el('li');
    // The palette is a listbox: each row is an option, and the selected one
    // is named. A screen reader reads "1 of 29" instead of nothing at all.
    li.setAttribute('role', 'option');
    li.id = `slash-opt-${item.cmd}`;
    li.setAttribute('aria-selected', i === slash.index ? 'true' : 'false');
    li.append(el('span', 'cmd', '/' + item.cmd), el('span', 'desc', item.desc));
    li.onmousedown = (ev) => { ev.preventDefault(); pickSlash(i); };
    list.append(li);
  });
  // Nothing matches: say so instead of vanishing. A palette that silently
  // disappears looks like the "/" did nothing at all.
  if (!slash.items.length) {
    const li = el('li', 'empty');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', 'false');
    li.append(el('span', 'desc', `ไม่พบคำสั่งที่ขึ้นต้นด้วย "/${typed}" — ลอง /help`));
    list.append(li);
  }
  $('slash').classList.remove('hidden');
  // The composer says whether the palette is open and which row is on it, so
  // the selection is not only a colour.
  const task = $('task');
  task.setAttribute('aria-expanded', 'true');
  task.setAttribute('aria-controls', 'slash-list');
  const chosen = slash.items[slash.index];
  if (chosen) task.setAttribute('aria-activedescendant', `slash-opt-${chosen.cmd}`);
  else task.removeAttribute('aria-activedescendant');
}

function openSlash(value) {
  slash.open = true;
  renderSlash(value);
}

function closeSlash() {
  slash.open = false;
  $('slash').classList.add('hidden');
  // And the composer says so: a palette that is closed but still claims to
  // be open is a lie a screen reader repeats.
  const task = $('task');
  task.setAttribute('aria-expanded', 'false');
  task.removeAttribute('aria-activedescendant');
}

function moveSlash(delta) {
  if (!slash.items.length) return;
  slash.index = (slash.index + delta + slash.items.length) % slash.items.length;
  renderSlash($('task').value, true); // arrows override the exact-match preference
}

/** Run the highlighted command. One with arguments leaves "/cmd " in the box so
 *  the argument can be typed instead of silently guessing. */
function pickSlash(index) {
  const item = slash.items[index];
  if (!item) return;
  closeSlash();
  const arg = $('task').value.slice(1).split(/\s+/).slice(1).join(' ').trim();
  $('task').value = '';
  if (item.args && !arg) {
    $('task').value = `/${item.cmd} `;
    $('task').focus();
    return;
  }
  void runCommand(item, arg);
}

function runCommand(item, arg) {
  addCommandOut(`/${item.cmd}${arg ? ` ${arg}` : ''}`);
  return Promise.resolve()
    .then(() => item.run(arg))
    .catch((err) => addNote(`คำสั่งไม่สำเร็จ: ${err.message}`));
}

/* ------------------------------------------------------- command handlers */

async function setModel(id) {
  const done = await rpc('config.set', { model: id }).catch((err) => ({ error: err.message }));
  if (done.error) { addNote(`เปลี่ยนโมเดลไม่ได้: ${friendly(done.error)}`); return; }
  state.settings = await rpc('settings.get').catch(() => null);
  await refreshHeader();
  addCommandOut(`โมเดล: ${id}`);
}

/**
 * Switch the provider.
 *
 * The switch is machine-wide, so it goes through the backend and lands in the
 * settings file — the terminal sees it too. The model list is rebuilt
 * afterwards: the models of one provider mean nothing to another.
 */
async function setProvider(id) {
  const done = await rpc('provider.set', { id }).catch((err) => ({ error: err.message }));
  if (done.error) { addNote(`สลับผู้ให้บริการไม่ได้: ${friendly(done.error)}`); return; }
  state.provider = id;
  await fillProviders(id);
  const st = await rpc('status').catch(() => null);
  await fillModels(st?.model ?? null);
  refreshMeta();
  addCommandOut(`ผู้ให้บริการ: ${id}`);
}

function pickProvider() {
  rpc('providers.list').then((res) => {
    const list = res?.providers ?? [];
    $('modal-title').textContent = 'เลือกผู้ให้บริการ';
    const body = $('modal-body');
    body.textContent = '';
    if (!list.length) body.append(el('p', 'dim', 'ยังไม่มีผู้ให้บริการที่ตั้งไว้ — เพิ่มได้ที่ /settings → ผู้ให้บริการ'));
    for (const p of list) {
      const row = el('button', p.id === ($('provider').value) ? 'primary' : null,
        `${p.label || p.id}${p.id === res.active ? ' — ใช้อยู่' : ''}${p.kind !== 'aipass' && !p.hasKey ? ' — ยังไม่มี key' : ''}`);
      row.style.display = 'block';
      row.style.width = '100%';
      row.style.textAlign = 'left';
      row.style.marginBottom = '6px';
      row.onclick = () => { hideModal(); void setProvider(p.id); };
      body.append(row);
    }
    $('modal-actions').textContent = '';
    const close = el('button', 'primary', 'ปิด');
    close.onclick = hideModal;
    $('modal-actions').append(close);
    openModal();
  }).catch((err) => addNote(err.message));
}

/**
 * Pick a model.
 *
 * The picker asks the site, not the cache: it is the sheet where a reader
 * goes to see what the site offers right now. Its Ctrl+R asks again without
 * closing the sheet (the window's keydown handler).
 */
function pickModel() {
  state.modelPicker = true;
  refreshModels().then((res) => {
    const list = res?.data ?? res?.models ?? [];
    $('modal-title').textContent = 'เลือกโมเดล';
    const body = $('modal-body');
    body.textContent = '';
    if (!list.length) body.append(el('p', 'dim', 'bridge ยังไม่ส่งรายการโมเดลมา'));
    for (const m of list) {
      const row = el('button', (m.id ?? m) === $('model').value ? 'primary' : null, `${m.id ?? m}${m.name && m.name !== m.id ? ` — ${m.name}` : ''}`);
      row.style.display = 'block';
      row.style.width = '100%';
      row.style.textAlign = 'left';
      row.style.marginBottom = '6px';
      row.onclick = () => { hideModal(); void setModel(m.id ?? m); };
      body.append(row);
    }
    $('modal-actions').textContent = '';
    const close = el('button', 'primary', 'ปิด');
    close.onclick = hideModal;
    $('modal-actions').append(close);
    openModal();
  }).catch((err) => addNote(err.message));
}

function setMode(mode) {
  if (!MODE_VIEWS[mode]) { addNote('โหมดที่ใช้ได้: ask | auto | yolo | plan'); return null; }
  $('mode').value = mode;
  const patch = MODE_VIEWS[mode];
  state.settings = { ...(state.settings ?? {}), ...patch };
  rpc('settings.set', patch).catch((err) => addNote(`เปลี่ยนโหมดไม่ได้: ${err.message}`));
  return $('mode').selectedOptions[0].textContent;
}

function pickMode() {
  $('modal-title').textContent = 'โหมดการทำงาน';
  const body = $('modal-body');
  body.textContent = '';
  const rows = [
    ['ask', 'ถามก่อนเขียนทุกไฟล์ — เห็น diff แล้วติ๊กก่อนลงดิสก์'],
    ['auto', 'เขียนเลย — ไม่ต้องอนุมัติทีละไฟล์'],
    ['yolo', 'เขียน + รันคำสั่ง shell ได้ด้วย'],
    ['plan', 'วางแผนก่อน — ร่างแผนให้อนุมัติ แล้วทำตามแผนในโหมด auto'],
  ];
  for (const [value, text] of rows) {
    const row = el('button', value === $('mode').value ? 'primary' : null, `${value} — ${text}`);
    row.style.display = 'block';
    row.style.width = '100%';
    row.style.textAlign = 'left';
    row.style.marginBottom = '6px';
    row.onclick = () => { hideModal(); void setMode(value); };
    body.append(row);
  }
  $('modal-actions').textContent = '';
  const close = el('button', 'primary', 'ปิด');
  close.onclick = hideModal;
  $('modal-actions').append(close);
  openModal();
}

/** Rotate the context now: the model summarises what it has done, that summary
 *  is recorded in the session, and the next run starts from it. */
async function compactNow() {
  const before = await rpc('status').then((s) => s.context).catch(() => null);
  addCommandOut(`บีบบริบท… ใช้ ${before?.used?.toLocaleString?.() ?? '?'} / ${before?.budget?.toLocaleString?.() ?? '?'} token — สรุปงานเก่าก่อน`);
  const done = await rpc('compact').catch((err) => ({ error: err.message }));
  if (done.error) { addNote(`บีบไม่ได้: ${done.error}`); return; }
  refreshMeter();
  if (done.summary) {
    const box = el('div', 'compaction-card');
    box.append(el('h4', null, 'สิ่งที่ยังจำอยู่หลังบีบ'));
    box.append(el('div', 'summary', done.summary));
    log.append(box);
    scrollDown();
  }
}

/**
 * The context meter. The upstream cannot trim its own history, so the only
 * control a user has over "it's losing the thread" is seeing the budget fill and
 * being able to rotate it. A percentage on its own would be noise next to the
 * model name; it earns its place by being the one number that explains a run
 * suddenly forgetting the beginning of the conversation.
 */
function refreshMeter(status = null) {
  // The status the caller already has is used rather than asked for again:
  // the header refreshes every ten seconds, and it was asking twice.
  const ask = status ? Promise.resolve(status) : rpc('status');
  ask.then((st) => {
    const use = st?.context;
    const slot = $('context');
    if (!slot) return;
    if (!use || !use.budget) { slot.classList.add('hidden'); return; }
    slot.classList.remove('hidden');
    const pct = use.percent;
    slot.textContent = `context ${pct}%`;
    slot.className = `context ${pct >= 85 ? 'full' : pct >= 60 ? 'warm' : ''}`;
    slot.title = `ใช้ไป ~${use.used.toLocaleString()} จากงว ${use.budget.toLocaleString()} token (สำรอง ${use.reserved.toLocaleString()} สำหรับคำตอบ)\n`
      + `${use.entries} รายการในบทสนทนา — ครบงบแล้วมันจะสรุปเก่าไว้แล้วเริ่มบทใหม่ให้เอง (/compact บีบได้เอง)`;
    if (use.needsCompaction && !state.needsCompaction) {
      state.needsCompaction = true;
      addNote('บริบทใกล้เต็ม — run ถัดไปจะสรุปงานเก่าไว้และเริ่มบทสนทนาใหม่ให้เอง (หรือกด /compact ตอนนี้)');
    }
    if (!use.needsCompaction) state.needsCompaction = false;
  }).catch(() => {});
}

/** The paint cache's numbers in one breath: how often a frame appended to the
 *  settled layer instead of re-rendering it, and what the misses cost. */
function showPaintStats() {
  const s = paintCacheStats();
  const pct = s.hitRate == null ? '— (ยังไม่มี settled layer)' : `${(s.hitRate * 100).toFixed(1)}%`;
  addCommandOut(`paint cache — hit rate ${pct} · hit ${s.hits.toLocaleString()} · miss ${s.misses.toLocaleString()} · cold ${s.cold.toLocaleString()} (รวม ${s.paints.toLocaleString()} เฟรม)`);
  addCommandOut(`settled ต่อเพิ่มแบบ append ${s.appended.toLocaleString()} ตัวอักษร · miss ต้อง repaint ${s.repainted.toLocaleString()} ตัวอักษร`);
  addCommandOut('hit = settled layer อยู่ครบ ต่อท้ายอย่างเดียว · miss = เขียนย้อนหลัง ต้อง repaint ทั้งก้อน · cold = ยังไม่มีอะไรให้แคช');
}

async function showStatus() {
  const st = await rpc('status').catch(() => null);
  if (!st) { addNote('bridge ไม่ตอบ'); return; }
  const credits = await rpc('credits').catch(() => null);
  const lines = [
    `bridge: ${st.bridge ? 'พร้อม' : 'ไม่พร้อม'} · extension: ${st.extensions ?? 0} · โปรเจกต์: ${st.root}`,
    `โมเดล: ${st.model ?? '-'} · mode: ${st.mode} · plan: ${st.plan ? 'เปิด' : 'ปิด'} · รันอยู่: ${st.running ? 'ใช่' : 'ไม่'}`,
    `ไฟล์รอเขียน: ${st.pending?.length ?? 0}`,
  ];
  if (st.app) lines.push(`build: ${st.app}${st.shell && st.shell !== st.app ? ` · shell: ${st.shell}` : ''}`);
  if (st.source) {
    const from = st.source === 'overlay' ? 'อัปเดตที่ติดตั้งไว้' : st.source === 'repo' ? 'โค้ดในเครื่อง (repo)' : 'ไฟล์ในตัวแอป (bundle)';
    lines.push(`ที่มาของโค้ด: ${from}`);
  }
  // The bridge's caches (models/quota/conversation) report what rode the cache
  // instead of the tab; a bridge too old to count them omits the block.
  if (st.cache) {
    const pair = (v) => v ? `${(v.hits ?? 0).toLocaleString()} hit / ${(v.fetches ?? 0).toLocaleString()} fetch` : '—';
    lines.push(`cache: โมเดล ${pair(st.cache.models)} · เครดิต ${pair(st.cache.quota)} · บทสนทนา ${pair(st.cache.conversation)}`);
  }
  if (credits) lines.push(`credits: ${credits.available?.toLocaleString?.() ?? credits.available} / ${credits.limit?.toLocaleString?.() ?? credits.limit}`);
  if (state.needsTab) lines.push('⚠ ยังไม่มี tab de.aipass.net ที่ล็อกอิน — กดปุ่มเปิดได้จาก welcome card');
  for (const line of lines) addCommandOut(line);
}


  return { COMMANDS, slash, slashMatches, slashTyping, MODE_VIEWS, MODE_CYCLE, renderSlash, openSlash, closeSlash, moveSlash, pickSlash, runCommand, setMode, setModel, setProvider, pickProvider, pickModel, pickMode, compactNow, showPaintStats, showStatus, refreshMeter };
}

export default createCommands;
