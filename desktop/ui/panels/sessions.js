// The rail: the history of this project's conversations, and the folds
// around it.
//
// Ninety-nine sessions on this machine and counting — a list of forty with no
// filter is a list nobody scrolls, so it filters as you type, shows the date a
// session is from, and keeps the newest first.
//
// The playbooks and the facts the app remembers live here too: they are read
// into the settings sheet, and the sheet asks the rail for them.


/* The one name rule the window's own inputs share with the library, and the
   sentence a "use" action drops into the composer (the SKILL word is the
   model's own wire protocol, desktop/AGENTS.md): the draft names the playbook
   the way the loop expects it loaded, and the reader appends the actual task. */
export const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/i;
export const skillUsePhrase = (name) => `อ่านคู่มือ ${name} (SKILL ${name}) และทำตามคู่มือนั้นสำหรับงานนี้: `;

/**
 * The rail: the session list, the folds, the playbooks and the facts.
 *
 * @param {object} ctx the window it draws into
 */
export function createSessionsPanel(ctx) {
  const { $, el, state, rpc, clickable, addNote, addCommandOut, hideModal, openModal } = ctx;

  /* Thai day words for the session list. The backend names a session after the
   moment it started ("2026-10-17 09:07"), and a wall of those spells the same
   date twice in every row — those rows show the clock face, and the day it
   belongs to reads as a word. */
const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

/* The midnight a day starts at, and how many midnights back a moment is. Two
   questions ask that — the word a row shows and the group it lands in — and
   they must not disagree, so the arithmetic lives here once. */
const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const daysAgo = (when) => Math.round((midnight(new Date()) - midnight(when)) / 86_400_000);

function sessionDay(when) {
  const away = daysAgo(when);
  if (away <= 0) return 'วันนี้';
  if (away === 1) return 'เมื่อวาน';
  if (away < 7) return `${away} วันก่อน`;
  const day = `${when.getDate()} ${TH_MONTHS[when.getMonth()]}`;
  return when.getFullYear() === new Date().getFullYear() ? day : `${day} ${String(when.getFullYear()).slice(2)}`;
}

/**
 * The bucket a session falls in. A history of 99 rows with no groups is a
 * wall of clocks; the groups turn it into a handful of questions ("today",
 * "this week", "older") and the clock stays where it belongs — in the row.
 */
function sessionBucket(when) {
  if (!when || Number.isNaN(when.getTime())) return 'เก่ากว่านั้น';
  const away = daysAgo(when);
  if (away <= 0) return 'วันนี้';
  if (away === 1) return 'เมื่อวาน';
  if (away < 7) return 'สัปดาห์นี้';
  if (away < 31) return 'เดือนนี้';
  return 'เก่ากว่านั้น';
}

/* ----------------------------------------------------------------- the rail */

/**
 * The fold: two lists want a 264px rail, and the reader is the one who
 * decides which of them gets the room. The answer is remembered, because
 * deciding it again every morning is a decision nobody made on purpose.
 */
const FOLD_KEY = 'aipass.side.fold';
const readFolds = () => {
  try { return JSON.parse(localStorage.getItem(FOLD_KEY) ?? '{}') ?? {}; } catch { return {}; }
};
function applyFold(id, folded) {
  $(id)?.classList.toggle('folded', folded);
  // The section and its button carry the same name, minus the suffix:
  // files-section and files-fold.
  $(id.replace(/-section$/, '-fold'))?.setAttribute('aria-expanded', String(!folded));
}
function toggleFold(id) {
  const folded = !$(id)?.classList.contains('folded');
  applyFold(id, folded);
  const folds = readFolds();
  folds[id] = folded;
  try { localStorage.setItem(FOLD_KEY, JSON.stringify(folds)); } catch { /* storage off */ }
}
$('sessions-fold').onclick = () => toggleFold('sessions-section');
$('files-fold').onclick = () => toggleFold('files-section');
for (const id of ['sessions-section', 'files-section']) {
  if (readFolds()[id]) applyFold(id, true);
}

/**
 * ↑ and ↓ walk a list, the way every file tree does: a list you can only
 * reach with the mouse is half a list, and the mouse is not the only thing
 * a person has.
 */
function arrowNav(list, ev) {
  if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
  const rows = [...(list?.children ?? [])].filter((r) => r.tabIndex === 0);
  if (!rows.length) return;
  const here = rows.indexOf(ev.target);
  const next = ev.key === 'ArrowDown' ? here + 1 : here - 1;
  if (next < 0 || next >= rows.length) return;
  ev.preventDefault();
  rows[next].focus?.();
  rows[next].scrollIntoView?.({ block: 'nearest' });
}
$('sessions').addEventListener('keydown', (ev) => arrowNav($('sessions'), ev));
$('files').addEventListener('keydown', (ev) => arrowNav($('files'), ev));

/**
 * The session list. 99 sessions on this machine and counting — a list of 40 with
 * no filter is a list nobody scrolls, so it filters as you type, shows the date
 * a session is from, and keeps the newest first.
 */
async function refreshSessions() {
  const list = await rpc('session.list').catch(() => []);
  const ul = $('sessions');
  ul.textContent = '';
  const query = ($('session-filter')?.value ?? '').trim().toLowerCase();
  const matched = list.filter((s) => !query || `${s.title ?? ''} ${s.id}`.toLowerCase().includes(query));
  const shown = matched.slice(0, 60);
  // How many there are, next to the label — a list whose size is invisible is
  // a list you cannot tell apart from "nothing there". While the filter is on
  // it says how many it let through, so a short list reads as a filter and
  // not as an empty history.
  const count = $('session-count');
  if (count) {
    count.textContent = query
      ? `${matched.length}/${list.length}`
      : (list.length ? String(list.length) : '');
  }
  // Past 40 sessions the picker is a junk drawer, not a list: the one-click
  // archive (nothing deleted, files move to <project>/archive/) sits above it
  // instead of hiding in a settings page. It waits for a search to finish —
  // a tidying button in the middle of a filtered list is noise.
  if (list.length > 40 && !query) {
    const bar = el('li', 'dim archive-bar');
    const btn = el('button', 'mini', `เก็บ ${list.length - 40}+ บทสนทนาเก่า`);
    btn.title = 'ย้ายบทสนทนาที่เงียบเกิน 30 วันไป archive/ (ไม่ลบไฟล์)';
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        const out = await rpc('session.archive', { olderThanDays: 30, limit: 50 });
        addCommandOut(out?.count ? `เก็บ ${out.count} บทสนทนาเก่าเข้า archive/ แล้ว` : 'ไม่มีบทสนทนาเก่าเกิน 30 วันให้เก็บ');
      } catch (err) { addNote(`เก็บไม่ได้: ${err.message}`); }
      await refreshSessions();
    };
    bar.append(btn);
    ul.append(bar);
  }
  if (!shown.length) {
    ul.append(el('li', 'dim', query ? 'ไม่พบบทสนทนาที่ค้น' : 'ยังไม่มีบทสนทนา'));
  }
  // The group the rows fall in. It changes as the list walks down the days,
  // and each change opens a new group.
  let lastBucket = null;
  for (const s of shown) {
    const li = el('li', s.id === state.sessionId ? 'active' : '');
    // A timestamp title only needs its clock face in the row; the day is the
    // sub-column's job, said in a word when it is close enough to have a word.
    const title = s.title ?? '';
    const stamped = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}:\d{2})/.exec(title);
    const when = s.updated
      ? new Date(s.updated)
      : stamped
        ? new Date(+stamped[1], +stamped[2] - 1, +stamped[3], +stamped[4], +stamped[5])
        : null;
    // A title that starts with a clock and then says something is a session
    // somebody named: the name belongs in the row, the clock does not.
    const named = stamped ? title.slice(stamped[0].length).replace(/^[\s·:—–-]+/, '') : title;
    // The list is sorted by the last change, so the clock in the row is the
    // last change too — otherwise the column reads out of order.
    const clock = when
      ? `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
      : '';
    // The group says when; the row says what, and at what hour.
    const bucket = sessionBucket(when);
    if (bucket !== lastBucket) {
      ul.append(el('li', 'day-head', bucket));
      lastBucket = bucket;
    }
    const label = stamped ? (named || clock || stamped[4]) : (named || '(untitled)');
    li.append(el('span', 'name', label));
    if (named && clock) li.append(el('span', 'sub', clock));
    li.title = `${s.title ?? '(untitled)'}\n${s.id}\n${when ? when.toLocaleString() : ''}`;
    // Export: the transcript as a file the person can keep or send to
    // somebody else. The row itself opens the session, so the button stops the
    // click that would do that — a button inside a row is that button's own
    // business.
    const out = el('button', 'mini', 'ส่งออก');
    out.title = 'ส่งออกบทสนทนานี้เป็นไฟล์ md หรือ html';
    out.onclick = (ev) => { ev.stopPropagation?.(); void ctx.exportSession(s.id, s.title); };
    li.append(out);
    clickable(li, () => void ctx.openSession(s.id));
    ul.append(li);
  }
  await drawArchived(ul);
}

/**
 * The sessions that are in the archive, and the way back out of it.
 *
 * "เก็บ" (archive) moves a session out of the picker's way, into
 * `<project>/archive/` — nothing is deleted, but until now nothing could
 * bring one back either, which made the archive a one-way door. The row
 * says how many are in there, and each of them can be put back where it was.
 */
async function drawArchived(ul) {
  const archived = await rpc('session.archived').catch(() => []);
  if (!archived.length) return;
  const bar = el('li', 'dim archive-bar');
  const btn = el('button', 'mini', `คืนจากที่เก็บ (${archived.length})`);
  btn.title = 'บทสนทนาที่เก็บไว้ใน archive/ — กดเพื่อดูและคืนกลับเข้ารายการ';
  // The one thing in the store that deletes. It asks first, it says what it
  // will do, and it only ever touches what has been in the archive for
  // months — a project that keeps every conversation it ever had is a
  // project that runs out of disk.
  const prune = el('button', 'mini', 'ลบที่เก็บเก่า');
  prune.title = 'ลบบทสนทนาที่อยู่ใน archive/ มานานเกิน 90 วัน (ลบถาวร)';
  prune.onclick = async () => {
    if (!window.confirm('ลบบทสนทนาที่เก็บไว้นานเกิน 90 วันอย่างถาวร?')) return;
    prune.disabled = true;
    try {
      const out = await rpc('session.prune', { olderThanDays: 90, limit: 50 });
      addCommandOut(out?.count ? `ลบบทสนทนาที่เก็บเก่า ${out.count} รายการแล้ว` : 'ไม่มีบทสนทนาที่เก็บเก่าเกิน 90 วันให้ลบ');
    } catch (err) { addNote(`ลบไม่ได้: ${err.message}`); }
    await refreshSessions();
  };
  let open = false;
  const box = el('div', 'archived-box');
  const draw = () => {
    box.textContent = '';
    for (const s of archived) {
      const row = el('div', 'archived-row');
      const when = s.updated ? new Date(s.updated) : null;
      const name = el('span', 'name', s.title ?? '(untitled)');
      name.title = `${s.title ?? '(untitled)'}\n${s.id}\n${when ? when.toLocaleString() : ''}`;
      row.append(name);
      if (when) row.append(el('span', 'sub', sessionDay(when)));
      const back = el('button', 'mini', 'คืน');
      back.title = 'คืนบทสนทนานี้เข้ารายการ';
      back.onclick = async () => {
        back.disabled = true;
        try {
          await rpc('session.unarchive', { id: s.id });
          addCommandOut(`คืนบทสนทนา "${s.title ?? '(untitled)'}" เข้ารายการแล้ว`);
        } catch (err) { addNote(`คืนไม่ได้: ${err.message}`); }
        await refreshSessions();
      };
      row.append(back);
      box.append(row);
    }
  };
  btn.onclick = () => {
    open = !open;
    btn.textContent = open ? `ปิดที่เก็บ (${archived.length})` : `คืนจากที่เก็บ (${archived.length})`;
    if (open) { draw(); box.hidden = false; } else { box.hidden = true; }
  };
  bar.append(btn, prune);
  ul.append(bar);
  ul.append(box);
}

/**
 * The playbooks on disk.
 *
 * They used to be a folded row in the rail: a heading you clicked to find out
 * what it held, in a column whose job is the work. The list belongs to the
 * settings sheet now, next to the folders it is searched in — so the window
 * only has to remember what is there, and the sheet draws it when it opens.
 */
async function refreshSkills() {
  state.skills = await rpc('skills.list').catch(() => []);
  return state.skills;
}

/** How a library's role label reads on screen. */
const ROLE_TH = { user: 'ผู้ใช้', project: 'โปรเจกต์', configured: 'ตั้งไว้', 'built-in': 'ในตัว' };

/**
 * Invoke a playbook: the draft is filled with the phrase that makes the next
 * run load it, and the draft storage is synced through the one saveDraft the
 * composer listens with — an assignment fires no input event.
 */
function useSkill(name) {
  const task = $('task');
  task.value = skillUsePhrase(name);
  ctx.saveDraft?.();
  task.focus();
  addCommandOut(`เติมคำเรียกคู่มือ "${name}" ในช่องพิมพ์แล้ว — พิมพ์งานต่อท้ายแล้วส่ง`);
}

/**
 * Remove a playbook this person installed. The delete is armed by the first
 * click and done by the second — a button that destroys on the click that
 * aims at "ดู" is how a playbook is lost to a mis-aimed pointer.
 */
async function removeSkillRow(btn, s, ul) {
  if (btn.dataset.arm !== '1') {
    btn.dataset.arm = '1';
    btn.textContent = 'ยืนยันลบ?';
    return;
  }
  const target = s.role === 'project' ? 'project' : 'user';
  const done = await rpc('skills.remove', { name: s.name, target }).catch((err) => ({ error: err.message }));
  if (done.error) { addNote(`ลบไม่ได้: ${done.error}`); return; }
  addCommandOut(`ลบคู่มือ ${s.name} ออกจาก${target === 'project' ? 'โปรเจกต์ (.aipass/skills)' : 'ผู้ใช้ (~/.aipass/skills)'}แล้ว`);
  renderSkillList(ul, await refreshSkills());
}

/**
 * The playbooks, drawn as a list you can open.
 *
 * A playbook opens in place, under its own row: the sheet is a modal of its
 * own, and a second modal on top of it would take the settings away while you
 * read. Each row carries the invoke and (for the libraries a person may write)
 * the remove — the list is where a playbook is managed, not only named.
 */
function renderSkillList(ul, skills = state.skills) {
  ul.textContent = '';
  if (!skills.length) {
    ul.append(el('li', 'dim', '(ยังไม่มีคู่มือ — กด "ติดตั้งคู่มือ…" หรือวางไฟล์ .md ในโฟลเดอร์คู่มือ)'));
    return;
  }
  for (const s of skills) {
    const li = el('li');
    const row = el('div', 'skill-row');
    const name = el('span', 'name', s.name);
    name.title = s.file ?? '';
    row.append(name);
    if (s.role) row.append(el('span', 'role dim', ROLE_TH[s.role] ?? s.role));
    const actions = el('span', 'skill-actions');
    const use = el('button', 'mini', 'ใช้');
    use.title = 'เติมคำเรียกคู่มือนี้ในช่องพิมพ์ — แล้วพิมพ์งานต่อท้าย';
    use.onclick = (ev) => { ev.stopPropagation(); useSkill(s.name); };
    actions.append(use);
    if (s.role === 'user' || s.role === 'project') {
      const del = el('button', 'mini danger', 'ลบ');
      del.onclick = (ev) => { ev.stopPropagation(); void removeSkillRow(del, s, ul); };
      actions.append(del);
    }
    row.append(actions);
    li.append(row);
    const view = el('pre', 'dim skill-body', '');
    view.hidden = true;
    // Selecting a line of the playbook is not asking to close it.
    view.onclick = (ev) => ev.stopPropagation();
    clickable(li, async () => {
      if (!view.hidden) { view.hidden = true; return; }
      const found = await rpc('skills.load', { name: s.name }).catch((err) => ({ error: err.message }));
      view.textContent = found.error ?? found.text ?? '';
      view.hidden = false;
    });
    li.append(view);
    ul.append(li);
  }
}

/**
 * The install dialog: a name, a library, and the markdown itself.
 *
 * The file is read in the page (FileReader), so no path crosses to the
 * backend — the backend receives text and a whitelisted name, the same two
 * things a paste carries. Overwriting an existing playbook asks once.
 */
function installSkillDialog({ onInstalled } = {}) {
  $('modal-title').textContent = 'ติดตั้งคู่มือ (playbook)';
  const body = $('modal-body');
  body.textContent = '';

  const nameIn = el('input');
  nameIn.placeholder = 'ชื่อคู่มือ — a-z 0-9 และ - เช่น deploy-check';
  nameIn.setAttribute('aria-label', 'ชื่อคู่มือ');
  nameIn.style.width = '100%';

  const targetSel = el('select');
  targetSel.setAttribute('aria-label', 'ไลบรารีปลายทาง');
  for (const [value, label] of [['user', 'ผู้ใช้ — ~/.aipass/skills'], ['project', 'โปรเจกต์ — .aipass/skills']]) {
    const opt = el('option', null, label);
    opt.value = value;
    targetSel.append(opt);
  }

  const textIn = el('textarea');
  textIn.placeholder = 'เนื้อหา markdown ของคู่มือ — วางที่นี่ หรือกดเลือกไฟล์ .md';
  textIn.setAttribute('aria-label', 'เนื้อหาคู่มือ');
  textIn.rows = 10;
  textIn.style.width = '100%';

  const pick = document.createElement('input');
  pick.type = 'file';
  pick.accept = '.md,.markdown,.txt,text/markdown,text/plain';
  pick.hidden = true;
  pick.addEventListener('change', () => {
    const f = pick.files?.[0];
    if (!f) return;
    if (!nameIn.value.trim()) nameIn.value = f.name.replace(/\.(md|markdown|txt)$/i, '');
    const reader = new FileReader();
    reader.onload = () => { textIn.value = String(reader.result ?? ''); };
    reader.readAsText(f);
  });
  const fileBtn = el('button', 'mini', 'เลือกไฟล์ .md…');
  fileBtn.onclick = () => pick.click();

  const row = el('div', 'skill-install-row');
  row.append(nameIn, targetSel);
  body.append(row, textIn, fileBtn, pick);

  const install = el('button', 'primary', 'ติดตั้ง');
  install.onclick = async () => {
    const name = nameIn.value.trim();
    const text = textIn.value;
    const target = targetSel.value;
    if (!SKILL_NAME_RE.test(name)) { addNote('ชื่อคู่มือใช้ได้เฉพาะ a-z 0-9 และ - (เริ่มด้วยตัวอักษรหรือตัวเลข)'); return; }
    if (!text.trim()) { addNote('ยังไม่มีเนื้อหา — วาง markdown หรือเลือกไฟล์ .md ก่อน'); return; }
    const send = (overwrite) => rpc('skills.install', { name, text, target, overwrite });
    let done = await send(false).catch((err) => ({ error: err.message }));
    if (done.error && /already exists/.test(done.error)) {
      if (typeof confirm === 'function' && !confirm(`มีคู่มือ "${name}" อยู่แล้ว — เขียนทับ?`)) { addNote('ยกเลิกการเขียนทับ'); return; }
      done = await send(true).catch((err) => ({ error: err.message }));
    }
    if (done.error) { addNote(`ติดตั้งไม่ได้: ${done.error}`); return; }
    addCommandOut(`ติดตั้งคู่มือ ${name} ลง${target === 'project' ? 'โปรเจกต์ (.aipass/skills)' : 'ผู้ใช้ (~/.aipass/skills)'}แล้ว${done.overwritten ? ' (เขียนทับ)' : ''}`);
    hideModal();
    await refreshSkills();
    await onInstalled?.();
  };

  $('modal-actions').textContent = '';
  const close = el('button', null, 'ปิด');
  close.onclick = hideModal;
  $('modal-actions').append(install, close);
  openModal();
}

/**
 * The facts the app carries between sessions.
 *
 * They live in the settings sheet now, not in the rail: this is the question
 * "what does it remember about me?", and the place people look for that is
 * the settings — next to the rules and the plugins, not next to the files you
 * are working on. The list is drawn into whatever container the sheet gives
 * it, so opening the sheet always shows what is true right now.
 */
async function renderMemoryFacts(ul, head) {
  const res = await rpc('memory.list').catch(() => null);
  const facts = res?.facts ?? [];
  if (head) head.textContent = facts.length ? `facts ข้าม session (${facts.length})` : 'facts ข้าม session';
  if (!ul) return facts;
  ul.textContent = '';
  if (!facts.length) {
    const li = el('li', 'dim');
    li.append(el('span', 'fact', '(ยังไม่มี — รัน /compact หรือให้ agent ทำงาน)'));
    ul.append(li);
    return facts;
  }
  for (const f of facts) {
    const li = el('li');
    li.append(el('span', 'fact', f));
    ul.append(li);
  }
  return facts;
}

  return { refreshSessions, refreshSkills, renderSkillList, renderMemoryFacts, useSkill, installSkillDialog, sessionDay, sessionBucket };
}

export default createSessionsPanel;
