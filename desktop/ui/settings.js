// The settings sheet — a category rail on the left, one page of settings on
// the right, so a section you never touch is one click away instead of one
// scroll away.
//
// Every page is a tab of its own: it renders its own page and it saves its
// own fields. `openSettings` only assembles them — the rail, the pages, and
// the one button that asks every tab what it would write.
//
// What the older sheet got right, this keeps: edits are staged in a draft and
// only "บันทึก" writes them, validation names the problem instead of saving a
// bad number, and the context meter ticks live while the sheet is open.
//
// Three of the pages are not settings at all: the repository's own buttons
// (git), the media models and the schedule. They live here because this is
// where the rest of the app's surfaces are — and because a page that acts on
// the machine belongs next to the page that says what the machine may do.
import { renderGitTab, renderMediaTab, renderScheduleTab } from './panels/tools.js';


/**
 * The settings sheet: one page per tab, one save for all of them.
 *
 * @param {object} ctx the window it draws into
 */
export function createSettings(ctx) {
  const { $, el, state, rpc, addNote, addCommandOut, friendly, applyTheme, refreshHeader, refreshSkills, renderSkillList, renderMemoryFacts, installSkillDialog, applySettingsToUi, stageLabel, fillProviders, paintPluginPanels, hideModal, openModal } = ctx;


/* The pages of the sheet — one tab each. A tab renders its own page and
   saves its own fields; `openSettings` only assembles them. */
/**
 * What one tab would write, and what is wrong with it.
 *
 * Every tab answers the same two questions: "what would you save?" and "what
 * is wrong with what you typed?". The sheet asks all of them, and writes
 * nothing while one of them has a problem — a save that says nothing when it
 * refuses is the same silence the sheet exists to prevent.
 *
 * @typedef {{patch: object, problems: string[]}} TabSave
 */

/** A tab that changes nothing in the settings file: it acts on its own. */
const saveEmptyTab = () => ({ patch: {}, problems: [] });

/**
 * The model tab: the model, the permissions and the budgets of one run.
 *
 * @param {object} sheet
 * @returns {TabSave}
 */
const saveModelTab = (sheet) => {
  const d = sheet.draft;
  const problems = [];
  // The temperature select speaks in strings ('default' / '0.7'); the settings
  // file stores null or a number, so the sheet converts on the way out — the
  // same trick the wall-clock minutes below play.
  const temperature = d.temperature == null || d.temperature === 'default' ? null : Number(d.temperature);
  // Check before writing: a budget under its reserve is a mistake the person
  // should hear about — not a setting that quietly misbehaves on the next
  // run. Zero steps is no mistake: it is the deliberate "no cap".
  const maxSteps = Number(d.maxSteps);
  if (!Number.isFinite(maxSteps) || maxSteps < 0) problems.push('สูงสุดกี่ step ต้องเป็น 0 ขึ้นไป (0 = ไม่จำกัด)');
  const maxToolCalls = Number(d.maxToolCalls);
  if (!Number.isFinite(maxToolCalls) || maxToolCalls < 1) problems.push('สูงสุดกี่ tool call ต้องเป็นตัวเลขอย่างน้อย 1');
  const maxWallClockMin = Number(d.maxWallClockMin);
  if (!Number.isFinite(maxWallClockMin) || maxWallClockMin < 1) problems.push('เวลาสูงสุดต่อคำสั่ง ต้องเป็นตัวเลขอย่างน้อย 1 นาที');
  if (d.maxCredits != null) {
    const creditCap = Number(d.maxCredits);
    if (!Number.isFinite(creditCap) || creditCap < 0) problems.push('เพดานเครดิตต้องเป็น 0 (ไม่จำกัด) หรือตัวเลขบวก');
  }
  if (d.maxResult != null) {
    const resultCap = Number(d.maxResult);
    if (!Number.isFinite(resultCap) || (resultCap !== 0 && resultCap < 500)) problems.push('สูงสุดกี่ byte ต่อผลเครื่องมือ ต้องเป็น 0 (ค่าเริ่มต้น) หรืออย่างน้อย 500');
  }
  // The language keys are checked only when the payload carries them: a
  // window talking to a backend that predates them must still save (the
  // server's own sane() fills the defaults), and an absent key is not an
  // invalid one.
  if (d.replyLanguage != null && !['th', 'en'].includes(d.replyLanguage)) problems.push('ภาษาที่ตอบผู้ใช้ต้องเป็น th หรือ en');
  if (d.minThaiRatio != null) {
    const minRatio = Number(d.minThaiRatio);
    if (!Number.isFinite(minRatio) || minRatio < 0 || minRatio > 1) problems.push('สัดส่วนอักษรไทยขั้นต่ำต้องอยู่ระหว่าง 0 ถึง 1');
  }
  if (d.repeatGuardMax != null) {
    const repeatMax = Number(d.repeatGuardMax);
    if (!Number.isFinite(repeatMax) || repeatMax < 1) problems.push('เพดานการบล็อกซ้ำต้องเป็นตัวเลขอย่างน้อย 1');
  }
  if (d.attempts != null) {
    const attemptsN = Number(d.attempts);
    if (!Number.isFinite(attemptsN) || attemptsN < 1 || attemptsN > 5) problems.push('รอบลองสูงสุดต่อคำสั่งต้องอยู่ระหว่าง 1 ถึง 5');
  }
  if (d.verifyCommand) {
    const command = String(d.verifyCommand);
    if (/[\r\n]/.test(command)) problems.push('คำสั่งตรวจต้องเป็นบรรทัดเดียว (คำสั่งเดียว)');
    else if (command.trim().length > 300) problems.push('คำสั่งตรวจยาวเกิน 300 ตัวอักษร');
  }
  return {
    problems,
    patch: {
      defaultModel: d.defaultModel,
      temperature,
      allowRun: d.allowRun,
      // The two switches the harness option sheet owns. They are sent only
      // when the machine has them: a backend that does not know the key
      // drops it (rpc/settings.mjs writes only the keys DEFAULTS knows), and
      // the window says so after the save instead of pretending it took.
      allowGitWrite: d.allowGitWrite,
      allowVerify: d.allowVerify,
      maxSteps: d.maxSteps,
      maxToolCalls: d.maxToolCalls,
      // The sheet's minutes go back to the stored milliseconds.
      maxWallClockMs: Math.round(maxWallClockMin) * 60_000,
      maxCredits: d.maxCredits,
      maxResult: d.maxResult,
      subagent: d.subagent,
      replyLanguage: d.replyLanguage,
      langCheck: d.langCheck,
      minThaiRatio: d.minThaiRatio,
      repeatGuard: d.repeatGuard,
      repeatGuardMax: d.repeatGuardMax,
      attempts: d.attempts,
      verifyCommand: d.verifyCommand,
      requireCheck: d.requireCheck,
    },
  };
};

/**
 * The context tab: the budget of the conversation and the share that rotates it.
 *
 * @param {object} sheet
 * @returns {TabSave}
 */
const saveContextTab = (sheet) => {
  const d = sheet.draft;
  const problems = [];
  const budget = Number(d.compaction?.contextTokens);
  const reserve = Number(d.compaction?.reserveTokens);
  if (!Number.isFinite(budget) || budget < 1000) problems.push('งบบริบทควร 1000 token ขึ้นไป');
  if (!Number.isFinite(reserve) || reserve < 128) problems.push('ส่วนสำรองควรอย่างน้อย 128 token');
  if (Number.isFinite(budget) && Number.isFinite(reserve) && reserve >= budget) problems.push('ส่วนสำรองต้องน้อยกว่างบทั้งหมด');
  return { problems, patch: { compactAtPercent: d.compactAtPercent, compaction: d.compaction } };
};

/**
 * The window tab: the theme and the chat page the bridge talks to.
 *
 * @param {object} sheet
 * @returns {TabSave}
 */
const saveWindowTab = (sheet) => {
  const d = sheet.draft;
  const problems = [];
  if (d.chatUrl && !/^https?:\/\//.test(String(d.chatUrl))) problems.push('หน้า chat ต้องขึ้นต้นด้วย http:// หรือ https://');
  return { problems, patch: { theme: d.theme, chatUrl: d.chatUrl, autoOpenTab: d.autoOpenTab } };
};

/**
 * The playbook tab: the folders the manuals are searched in.
 *
 * @param {object} sheet
 * @returns {TabSave}
 */
const saveSkillsTab = (sheet) => ({ patch: { skillsDirs: sheet.draft.skillsDirs }, problems: [] });

/**
 * The rules tab: the path rules that step aside from the mode.
 *
 * @param {object} sheet
 * @returns {TabSave}
 */
const saveRulesTab = (sheet) => {
  const problems = [];
  // Path rules get the same treatment: an empty pattern would be dropped by
  // the server silently, and a duplicate pattern is a rule that can never be
  // reached — first match wins. Both look like protection and behave like
  // nothing, which is the exact failure the sheet exists to prevent.
  const rules = Array.isArray(sheet.draft.rules) ? sheet.draft.rules : [];
  for (const [i, r] of rules.entries()) {
    if (!r.pattern?.trim()) problems.push(`กฎที่ ${i + 1} ยังไม่มี pattern`);
  }
  const seen = new Set();
  for (const r of rules) {
    const p = r.pattern?.trim();
    if (!p) continue;
    if (seen.has(p)) problems.push(`pattern "${p}" ซ้ำ — กฎแรกที่ match ชนะ อันหลังไม่ทำงาน`);
    seen.add(p);
  }
  return { problems, patch: { rules } };
};

// The pages of the sheet. Each one renders its own page and saves its own
// fields — the sheet only asks them.

const renderContextTab = async (page, sheet) => {    // The context meter, live: what is used, what happens at the limit, and
    // the three numbers that decide when the rotation fires.
    const meter = el('div', 'ctx-meter');
    const st = await rpc('status').catch(() => null);
    const use = st?.context ?? {};
    const pct = use.percent ?? 0;
    const at = use.compactAt ?? 40;
    const bar = el('div', `ctx-bar ${use.needsCompaction ? 'full' : pct >= at ? 'warm' : ''}`);
    bar.id = 'ctx-bar';
    bar.style.setProperty('--pct', `${pct}%`);
    bar.style.setProperty('--at', `${at}%`);
    bar.title = `ใช้ ${pct}% — จะบีบเอ็นตอน ${at}%`;
    meter.append(bar, el('span', 'dim', `ใช้ ~${(use.used ?? 0).toLocaleString()} จากงบ ${(use.budget ?? 0).toLocaleString()} token (${pct}%) · ${use.entries ?? 0} รายการในบทสนทนา`));
    page.append(meter);
    page.append(el('p', 'settings-empty', `de.aipass.net เก็บบริบทไว้บนเซิร์ฟเวอร์และลบไม่ได้ — พอ context ถึง ${at}% ระบบจะสรุปงานเก่าแล้วเริ่มบทสนทนาใหม่เอง (หรือพิมพ์ /compact ตอนนี้)`));
    const group = el('div', 'set-group');
    group.append(sheet.row('บีบเอ็นตอน context เต็มกี่ %', `ตอนนี้ ${at}% — ค่าต่ำ = สรุปบ่อย ประหยัดบริบทแต่เสียรายละเอียด`, sheet.control({ key: 'compactAtPercent', type: 'number' })));
    group.append(sheet.row('งบบริบทก่อนหมุนเวียน (token)', 'ยิ่งสูงยิ่งจำได้มาก แต่เสียเครดิตเร็วขึ้น เพราะส่งบริบทเก่าซ้ำ', sheet.control({ key: 'compaction.contextTokens', type: 'number' })));
    group.append(sheet.row('สำรองสำหรับคำตอบ (token)', 'ที่ว่างไว้ให้โมเดลตอบ — ต้องน้อยกว่างบทั้งหมด', sheet.control({ key: 'compaction.reserveTokens', type: 'number' })));
    group.append(sheet.row('บทสนทนาล่าสุดที่เก็บดิบ (bytes)', 'ส่วนท้ายของบทสนทนาจะคงอยู่ตรง ๆ ไม่ถูกย่อรวม', sheet.control({ key: 'compaction.keepRecentBytes', type: 'number' })));
    page.append(group);
};
const renderProvidersTab = async (page, sheet) => {    // Who answers the run: the built-in AiPASS provider (the local bridge
    // and its tab) and every added API provider.
    //
    // The key is typed here once and filed by the backend — it never comes
    // back out, so the list can only say whether a provider has one. A
    // provider whose env var is named needs no key here at all: the
    // environment answers first, and the file is only the fallback for a
    // desktop that has no shell to export into.
    const list = el('div', 'provider-list');
    const out = el('div', 'install-out dim', '');
    page.append(list);

    const paint = async () => {
      const res = await rpc('providers.list').catch(() => null);
      const rows = res?.providers ?? [];
      state.providers = rows;
      list.textContent = '';
      for (const p of rows) {
        const card = el('div', 'provider-card');
        const head = el('div', 'plugin-head');
        head.append(el('div', 'plugin-name', p.label || p.id));
        const state_ = p.id === res.active ? 'ใช้อยู่'
          : (p.kind === 'aipass' ? 'ในตัว' : (p.hasKey ? 'มี key' : 'ยังไม่มี key'));
        head.append(el('span', `plugin-state${p.id === res.active ? ' on' : ''}`, state_));
        card.append(head);
        card.append(el('div', 'plugin-desc', p.kind === 'aipass'
          ? 'de.aipass.net ผ่าน bridge และแท็บที่ล็อกอินอยู่ — ใช้เครดิตของเว็บ'
          : `${p.kind} · ${p.baseUrl}${p.apiKeyEnv ? ` · key: $${p.apiKeyEnv}` : ''}${p.models?.length ? ` · ${p.models.length} โมเดล` : ''}`));
        const actions = el('div', 'plugin-actions');
        if (p.kind !== 'aipass') {
          const use = el('button', null, p.id === res.active ? 'ใช้อยู่' : 'ใช้ตัวนี้');
          use.disabled = p.id === res.active;
          use.onclick = async () => {
            use.disabled = true;
            await rpc('provider.set', { id: p.id })
              .catch((e) => { out.className = 'install-out err'; out.textContent = `err: ${e.message}`; });
            await paint();
            await fillProviders(p.id);
          };
          const test = el('button', null, 'ทดสอบ');
          test.onclick = async () => {
            test.disabled = true;
            out.className = 'install-out dim';
            out.textContent = 'กำลังทดสอบ…';
            const answer = await rpc('provider.test', { id: p.id }).catch((e) => ({ ok: false, detail: e.message }));
            out.className = answer.ok ? 'install-out' : 'install-out err';
            out.textContent = answer.ok ? `พร้อม — ${answer.detail}` : `ไม่ผ่าน — ${answer.detail}`;
            test.disabled = false;
          };
          const del = el('button', 'danger-btn', 'ลบ');
          del.onclick = async () => {
            if (!window.confirm(`ลบผู้ให้บริการ "${p.id}"? (key ที่บันทึกไว้จะหายด้วย)`)) return;
            await rpc('provider.remove', { id: p.id })
              .catch((e) => { out.className = 'install-out err'; out.textContent = `err: ${e.message}`; });
            await paint();
            await fillProviders();
          };
          actions.append(use, test, del);
        }
        card.append(actions);
        list.append(card);
      }
    };
    await paint();

    // The form that adds one. Everything here is the spec; the key is the
    // only secret, and it is written once.
    const form = el('div', 'set-group');
    const field = (label, note, node) => {
      const input = document.createElement('input');
      input.type = 'text';
      node.append(input);
      return sheet.row(label, note, node);
    };
    const idBox = el('div');
    const labelBox = el('div');
    const kindBox = el('div');
    const kindSel = document.createElement('select');
    for (const [v, text] of [['openai', 'OpenAI-compatible (OpenAI, OpenRouter, Groq, Ollama…)'], ['anthropic', 'Anthropic (Messages API)']]) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = text;
      kindSel.append(opt);
    }
    kindBox.append(kindSel);
    const urlBox = el('div');
    const envBox = el('div');
    const modelsBox = el('div');
    const keyBox = el('div');
    const keyIn = document.createElement('input');
    keyIn.type = 'password';
    keyIn.placeholder = 'ว่างไว้ = ใช้ตัวแปรสภาพแวดล้อม';
    keyBox.append(keyIn);
    form.append(
      field('id', 'ตัวอักษรเล็ก ตัวเลข . _ - เช่น openai, my-gateway', idBox),
      field('ชื่อที่แสดง', 'เช่น OpenAI (ผ่าน gateway)', labelBox),
      sheet.row('โปรโตคอล', 'ชนิด API ที่ปลายทางพูด', kindBox),
      field('base url', 'เช่น https://api.openai.com/v1 หรือ http://localhost:11434/v1', urlBox),
      field('ตัวแปรสภาพแวดล้อมของ key', 'เช่น OPENAI_API_KEY — ถ้าตั้งไว้ ตัวนี้มาก่อนไฟล์', envBox),
      field('โมเดล', 'คั่นด้วยจุลภาค — เว้นว่างไว้ถ้าไม่รู้ (จะถามจาก provider ตอนใช้)', modelsBox),
      sheet.row('API key', 'เก็บใน ~/.aipass/credentials.json (สิทธิ์เฉพาะเจ้าของ) — ไม่มีก็ใช้ตัวแปรสภาพแวดล้อมแทน', keyBox),
    );
    const save = el('button', 'primary', 'เพิ่มผู้ให้บริการ');
    save.onclick = async () => {
      save.disabled = true;
      out.className = 'install-out dim';
      out.textContent = 'กำลังบันทึก…';
      const body = {
        id: idBox.querySelector('input')?.value?.trim(),
        label: labelBox.querySelector('input')?.value?.trim(),
        kind: kindSel.value,
        baseUrl: urlBox.querySelector('input')?.value?.trim(),
        apiKeyEnv: envBox.querySelector('input')?.value?.trim(),
        models: (modelsBox.querySelector('input')?.value ?? '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean),
        key: keyIn.value?.trim(),
      };
      const answer = await rpc('provider.save', body).catch((e) => ({ error: e.message }));
      if (answer?.error) {
        out.className = 'install-out err';
        out.textContent = `err: ${answer.error}`;
        save.disabled = false;
        return;
      }
      out.className = 'install-out';
      out.textContent = `เพิ่ม "${body.id}" แล้ว — เลือกใช้ได้จากช่องผู้ให้บริการใต้ช่องพิมพ์`;
      keyIn.value = '';
      idBox.querySelector('input').value = '';
      labelBox.querySelector('input').value = '';
      urlBox.querySelector('input').value = '';
      envBox.querySelector('input').value = '';
      modelsBox.querySelector('input').value = '';
      save.disabled = false;
      await paint();
      await fillProviders();
    };
    const actionsRow = el('div', 'plugin-actions');
    actionsRow.append(save);
    form.append(actionsRow);
    page.append(form, out);
};
const renderMemoryTab = async (page, sheet) => {    // What the app remembers between sessions, and the one button that
    // makes it forget. It used to sit in the rail as a row folded away
    // under a heading nobody could place — a thing the app did that you
    // could only find by guessing. Here it is a page, next to the rules.
    const head = el('div', 'set-title');
    head.id = 'memory-head';
    const list = el('ul', 'list dim memory-list');
    list.id = 'memory';
    const clear = el('button', 'mini', 'ลืมทั้งหมด');
    clear.id = 'memory-clear';
    clear.title = 'ลบ facts ที่จำไว้ข้าม session ทั้งหมด';
    clear.onclick = async () => {
      await rpc('memory.clear').catch(() => {});
      addCommandOut('ลืม facts ข้าม session ทั้งหมดแล้ว');
      await renderMemoryFacts(list, head);
    };
    page.append(head, list, clear);
    await renderMemoryFacts(list, head);
};
/**
 * The goal tab: the one objective every run in this project is chasing.
 *
 * It is not a setting of one run (that is the plan) and not something the app
 * remembers (that is memory): it is the person's answer to "what am I actually
 * trying to finish". Setting and replacing use the form; pause/resume and
 * clear act at once, like the memory page, because they answer an ongoing run
 * and waiting for "บันทึก" would be a trap.
 */
const renderGoalTab = async (page) => {
  const head = el('div', 'set-title');
  head.id = 'goal-head';
  const list = el('ul', 'list dim goal-list');
  list.id = 'goal';
  const objective = el('textarea');
  objective.id = 'goal-objective';
  objective.rows = 3;
  objective.placeholder = 'สิ่งที่โปรเจกต์นี้ต้องทำให้เสร็จ';
  const rounds = el('input');
  rounds.id = 'goal-rounds';
  rounds.type = 'number';
  rounds.min = '1';
  rounds.max = '64';
  rounds.title = 'จำนวนครั้งที่โมเดลจะถูกส่งกลับไปทำต่อ เมื่อสั่ง DONE ทั้งที่เป้าหมายยังไม่จบ';
  const save = el('button', 'primary', 'บันทึกเป้าหมาย');
  save.id = 'goal-set';
  const toggle = el('button', 'mini', 'พักเป้าหมาย');
  toggle.id = 'goal-toggle';
  const clear = el('button', 'mini', 'ลบเป้าหมาย');
  clear.id = 'goal-clear';
  const out = el('p', 'install-out dim', '');
  out.id = 'goal-out';
  let goal = null;

  async function paint() {
    const res = await rpc('goal.get').catch(() => null);
    goal = res?.goal ?? null;
    head.textContent = goal ? `เป้าหมายของโปรเจกต์ (${goal.status})` : 'เป้าหมายของโปรเจกต์';
    list.textContent = '';
    if (!goal) {
      list.append(el('li', 'dim', 'ยังไม่มีเป้าหมาย — ใส่ข้อความแล้วกดบันทึก'));
    } else {
      list.append(el('li', null, goal.objective));
      list.append(el('li', 'dim', `สถานะ ${goal.status} · รอบ ${goal.rounds}/${goal.maxRounds}${goal.blocked ? ` · ติด: ${goal.blocked}` : ''}${goal.done ? ` · เสร็จ: ${goal.done}` : ''}`));
    }
    objective.value = goal?.objective ?? '';
    rounds.value = String(goal?.maxRounds ?? 8);
    toggle.hidden = !goal || !['active', 'paused'].includes(goal.status);
    toggle.textContent = goal?.status === 'paused' ? 'ทำต่อ' : 'พักเป้าหมาย';
    clear.hidden = !goal;
    out.className = 'install-out dim';
    out.textContent = goal ? 'บันทึกข้อความใหม่ = แทนที่เป้าหมายเดิมและเริ่มนับรอบใหม่' : '';
  }

  const act = (fn) => async () => {
    try { await fn(); } catch (err) { out.className = 'install-out err'; out.textContent = friendly(err.message); return; }
    await paint();
  };
  save.onclick = act(async () => {
    const text = objective.value.trim();
    if (!text) throw new Error('ใส่เป้าหมายก่อน');
    if (goal?.objective === text) throw new Error('เป้าหมายนี้บันทึกอยู่แล้ว — แก้ข้อความก่อนถ้าจะเริ่มใหม่');
    const n = Number(rounds.value);
    await rpc('goal.set', { objective: text, maxRounds: Number.isFinite(n) && n > 0 ? n : undefined, force: true });
  });
  toggle.onclick = act(async () => { await rpc(goal?.status === 'paused' ? 'goal.resume' : 'goal.pause'); });
  clear.onclick = act(async () => { await rpc('goal.clear'); });

  const actions = el('div', 'plugin-actions');
  actions.append(save, toggle, clear);
  const roundsLabel = el('label', 'dim', 'รอบสูงสุด (1-64)');
  roundsLabel.append(rounds);
  page.append(head, list, objective, roundsLabel, actions, out);
  await paint();
};
const renderSkillsDirsTab = async (page, sheet) => {    const group = el('div', 'set-group');
    group.append(sheet.row('โฟลเดอร์คู่มือ', 'ทีละ path ต่อบรรทัด · ลองโฟลเดอร์ในโปรเจกต์ก่อน แล้วค่อย ~/.aipass/skills · /skill <ชื่อ> = เรียก · /skills = ดูที่มี · รายการรีเฟรชเองเมื่อบันทึก', sheet.control({ key: 'skillsDirs', type: 'textarea' })));
    page.append(group);
    // The playbooks those folders hold, right under the folders: the list
    // used to be a folded row in the rail, and the answer belongs next to
    // the thing that decides what is in it. Installing is here too — the
    // folder row and the button that fills it are one story.
    const head = el('h5', 'set-title heading', 'คู่มือที่มี');
    const install = el('button', 'mini', 'ติดตั้งคู่มือ…');
    install.onclick = () => installSkillDialog({
      onInstalled: async () => renderSkillList(list, await refreshSkills()),
    });
    head.append(install);
    const list = el('ul', 'list dim skill-list');
    page.append(head, list);
    renderSkillList(list, await refreshSkills());
};
const renderPluginsTab = async (page, sheet) => {    let live = sheet.details;

    // The install box: a source in, a report out — inspect runs nothing.
    // The click on "ติดตั้ง" is the consent moment: it is the first thing
    // that loads the code, so nothing may happen before the report is read.
    const box = el('div', 'set-group');
    const line = el('div', 'install-line');
    const src = document.createElement('input');
    src.type = 'text';
    src.placeholder = 'path ของไฟล์ .mjs หรือโฟลเดอร์ · https://… · github:owner/repo · npm:<package>';
    const check = el('button', null, 'ตรวจสอบ');
    line.append(src, check);
    const out = el('div', 'install-out dim', 'วางที่อยู่แล้วกดตรวจสอบ — ยังไม่มีอะไรถูกรันจนกว่าจะกดติดตั้ง');
    box.append(line, out);
    page.append(box);

    const empty = el('p', 'settings-empty');
    empty.append('ยังไม่มีปลั๊กอินที่ติดตั้งผ่านแอป — วางที่อยู่ด้านบน หรือวางไฟล์ .mjs ลง ');
    empty.append(el('code', null, sheet.details.dir));
    const cards = el('div');
    const markers = el('div', 'plugin-markers');
    page.append(empty, cards, markers);

    // The panels the plugins draw. They used to hang off the rail, where a
    // heading and an empty box read as a broken feature; here they sit next
    // to the plugin that draws them.
    const panels = el('section', 'plugin-panels');
    page.append(el('h5', 'set-title heading', 'แผงที่ปลั๊กอินวาด'), panels);
    state.panelHost = panels;

    const paint = () => {
      const known = live.known ?? live.loaded.map((pl) => pl.name);
      empty.style.display = (!known.length && !live.failed.length) ? '' : 'none';
      cards.textContent = '';
      for (const name of known) {
        const pl = live.loaded.find((x) => x.name === name) ?? null;
        const rec = live.registry?.[name] ?? pl?.installed ?? null;
        const on = Boolean(pl);
        const card = el('div', `plugin-card${on ? '' : ' off'}`);
        const head = el('div', 'plugin-head');
        head.append(el('div', 'plugin-name', `${name}${pl ? ` ${pl.version}` : ''}`));
        head.append(el('span', `plugin-state${on ? ' on' : ''}`, on ? 'เปิด' : 'ปิด'));
        card.append(head);
        card.append(el('div', 'plugin-desc', pl?.description || (on ? 'ไม่มีคำอธิบาย' : 'ปิดอยู่ — ไม่ถูกโหลด')));
        if (rec) {
          const note = el('div', 'plugin-source dim');
          note.textContent = `ที่มา: ${rec.source?.ref ?? '?'} · sha ${rec.sha256 ?? '?'}`;
          if (pl?.hashChanged) note.textContent += ' · ไฟล์เปลี่ยนหลังติดตั้ง — กดโหลดใหม่หรือติดตั้งทับถ้าไม่ใช่ฝีมือคุณ';
          card.append(note);
        } else {
          card.append(el('div', 'plugin-source dim', 'วางไฟล์เอง — ไม่ได้ติดตั้งผ่านแอป (ลบต้องยืนยันเป็นพิเศษ)'));
        }
        const actions = el('div', 'plugin-actions');
        const toggle = el('button', null, on ? 'ปิด' : 'เปิด');
        toggle.onclick = async () => {
          toggle.disabled = true;
          const res = await rpc(on ? 'plugins.disable' : 'plugins.enable', { name }).catch((e) => {
            out.className = 'install-out err';
            out.textContent = `err: ${e.message}${e.stage ? ` · ขั้นตอน: ${stageLabel(e.stage)}` : ''}`;
            return null;
          });
          if (res) await refresh();
          else toggle.disabled = false;
        };
        const del = el('button', 'danger-btn', 'ลบ');
        del.onclick = async () => {
          const first = rec
            ? `ลบปลั๊กอิน "${name}"? ไฟล์จะถูกเก็บไว้ใน .trash (กู้คืนได้)`
            : `"${name}" ไม่ได้ติดตั้งผ่านแอป — ไฟล์นี้คือผลงานของคุณ ยืนยันว่าจะย้ายไป .trash?`;
          if (!window.confirm(first)) return;
          if (!rec && !window.confirm('ยืนยันอีกครั้ง: ย้ายโฟลเดอร์นี้ไป .trash?')) return;
          del.disabled = true;
          const res = await rpc('plugins.remove', { name, force: true }).catch((e) => {
            out.className = 'install-out err';
            out.textContent = `err: ${e.message}${e.stage ? ` · ขั้นตอน: ${stageLabel(e.stage)}` : ''}`;
            return null;
          });
          if (res) await refresh();
          else del.disabled = false;
        };
        actions.append(toggle, del);
        card.append(actions);
        cards.append(card);
      }
      for (const f of live.failed) {
        const card = el('div', 'plugin-card bad');
        card.append(el('div', 'plugin-name', `โหลดไม่ได้ — ${f.file}`));
        card.append(el('div', 'plugin-desc', f.error));
        cards.append(card);
      }
      markers.textContent = '';
      if (live.tools.length) {
        markers.append('markers: ');
        markers.append(el('code', null, live.tools.join(', ')));
      }
    };

    const refresh = async () => {
      live = await rpc('plugins.list').catch(() => live);
      paint();
      // The panels follow what is installed: a plugin you just installed has
      // a panel, and the panel should be there now — not after a reload of
      // the window.
      state.pluginPanels = live.panels ?? [];
      await paintPluginPanels();
    };

    check.onclick = async () => {
      const source = src.value.trim();
      if (!source) { out.className = 'install-out err'; out.textContent = 'ใส่ path หรือ URL ก่อน'; return; }
      // The box says what it is doing while it does it: a source that has
      // to be fetched looks the same as one that is already on disk, and the
      // wait is the difference between the two.
      check.disabled = true;
      src.disabled = true;
      out.className = 'install-out dim';
      out.textContent = 'กำลังตรวจสอบแหล่งที่มา… (ยังไม่มีอะไรถูกรัน)';
      const info = await rpc('plugins.inspect', { source }).catch((e) => {
        out.className = 'install-out err';
        out.textContent = `err: ${e.message}${e.stage ? ` · ขั้นตอน: ${stageLabel(e.stage)}` : ''}`;
        return null;
      });
      check.disabled = false;
      src.disabled = false;
      if (!info) return;
      out.className = 'install-out';
      out.textContent = '';
      out.append(el('div', null, `ที่มา: ${info.ref}`));
      out.append(el('div', 'dim', `ชนิด: ${info.kind}${info.kind === 'path' ? '' : ' — ดึงมาจากที่นั้นเพื่ออ่าน ยังไม่มีอะไรถูกรัน'}`));
      out.append(el('div', 'dim', `${info.entry} · ${info.size.toLocaleString()} bytes · sha256 ${info.sha256.slice(0, 16)}…`));
      out.append(el('div', 'dim', 'ติดตั้ง = โหลดโค้ดนี้ในโปรเซสของแอปจริง ๆ ไม่มี sandbox — เทียบ sha256 กับต้นทางก่อนถ้าไม่แน่ใจ'));
      const install = el('button', 'primary', 'ติดตั้ง');
      install.onclick = async () => {
        install.disabled = true;
        check.disabled = true;
        src.disabled = true;
        out.className = 'install-out dim';
        out.textContent = 'กำลังติดตั้ง… (ดึงแหล่งที่มา → ตรวจโค้ด → สลับเข้าโฟลเดอร์ปลั๊กอิน)';
        const res = await rpc('plugins.install', { source: info.ref, expectedSha256: info.sha256 }).catch((e) => {
          out.className = 'install-out err';
          out.textContent = `err: ${e.message}${e.stage ? ` · ขั้นตอน: ${stageLabel(e.stage)}` : ''}`;
          // A folder that is not the installer's is refused by default; this
          // second click is the explicit force, and it still keeps a copy.
          if (/not installed by aipass|already exists/.test(e.message)) {
            const force = el('button', null, 'ติดตั้งทับ (เก็บสำเนาเดิมใน .trash)');
            force.onclick = async () => {
              force.disabled = true;
              out.className = 'install-out dim';
              out.textContent = 'กำลังติดตั้งทับ…';
              const forced = await rpc('plugins.install', { source: info.ref, expectedSha256: info.sha256, force: true }).catch((e2) => {
                out.className = 'install-out err';
                out.textContent = `err: ${e2.message}${e2.stage ? ` · ขั้นตอน: ${stageLabel(e2.stage)}` : ''}`;
                return null;
              });
              if (forced) {
                out.className = 'install-out ok-text';
                out.textContent = `ติดตั้งทับ ${forced.plugin?.name ?? ''} ${forced.plugin?.version ?? ''} แล้ว — สำเนาเดิมอยู่ใน .trash`;
                check.disabled = false;
                src.disabled = false;
                await refresh();
              } else force.disabled = false;
            };
            out.append(force);
          }
          check.disabled = false;
          src.disabled = false;
          return null;
        });
        if (res) {
          out.className = 'install-out ok-text';
          out.textContent = `ติดตั้ง ${res.plugin?.name ?? ''} ${res.plugin?.version ?? ''} แล้ว`;
          check.disabled = false;
          src.disabled = false;
          await refresh();
        } else install.disabled = false;
      };
      out.append(install);
    };

    const reload = el('button', null, 'โหลดปลั๊กอินใหม่');
    reload.onclick = async () => { await rpc('plugins.reload').catch(() => null); await refresh(); };
    page.append(reload);
    paint();
    state.pluginPanels = live.panels ?? [];
    await paintPluginPanels();
};
const renderMcpTab = async (page, sheet) => {    let live = sheet.mcpReady;
    const wrap = el('div');
    page.append(wrap);

    const paintMcp = () => {
      wrap.textContent = '';
      for (const s of live.servers ?? []) {
        const card = el('div', 'plugin-card');
        const head = el('div', 'plugin-head');
        head.append(el('div', 'plugin-name', s.name));
        const state = !s.enabled ? 'ปิด' : s.connected ? `${s.tools} tools` : 'เชื่อมต่อไม่ได้';
        head.append(el('span', `plugin-state${!s.enabled ? '' : s.connected ? ' on' : ' bad'}`, state));
        card.append(head);
        card.append(el('div', 'plugin-source dim',
          `${s.scope === 'project' ? 'โปรเจกต์นี้' : 'ทุกโปรเจกต์'} · ${s.command}${s.args?.length ? ` ${s.args.join(' ')}` : ''}${s.risk === 'read' ? ' · อ่านอย่างเดียว' : ' · เขียน (ถามตามโหมด)'}`));
        if (s.error) card.append(el('div', 'plugin-desc', s.error));
        const actions = el('div', 'plugin-actions');
        const toggle = el('button', null, s.enabled ? 'ปิด' : 'เปิด');
        toggle.onclick = async () => {
          toggle.disabled = true;
          const res = await rpc(s.enabled ? 'mcp.disable' : 'mcp.enable', { name: s.name, scope: s.scope }).catch(() => null);
          if (res) { live = res; paintMcp(); } else toggle.disabled = false;
        };
        const note = el('div', 'plugin-source dim');
        const test = el('button', null, 'ทดสอบ');
        test.onclick = async () => {
          test.disabled = true;
          note.className = 'plugin-source dim';
          note.textContent = 'กำลังเชื่อมต่อ…';
          const r = await rpc('mcp.test', { name: s.name, scope: s.scope }).catch((e) => ({ ok: false, error: e.message }));
          note.className = r.ok ? 'plugin-source ok-text' : 'plugin-source err-text';
          note.textContent = r.ok
            ? `เชื่อมต่อได้ใน ${r.ms} ms — ${r.tools.length} tools${r.tools.length ? `: ${r.tools.map((t) => t.name).join(', ')}` : ''}`
            : `err: ${r.error}`;
          test.disabled = false;
        };
        const del = el('button', 'danger-btn', 'ลบ');
        del.onclick = async () => {
          if (!window.confirm(`ลบ MCP server "${s.name}" ออกจาก${s.scope === 'project' ? 'โปรเจกต์นี้' : 'การตั้งค่าส่วนกลาง'}?`)) return;
          del.disabled = true;
          const res = await rpc('mcp.remove', { name: s.name, scope: s.scope }).catch(() => null);
          if (res) { live = res; paintMcp(); } else del.disabled = false;
        };
        actions.append(toggle, test, del);
        card.append(actions, note);
        wrap.append(card);
      }

      // The add form carries every field `aipass mcp add` takes — a form
      // that cannot express what the command can is half a feature.
      const nameI = document.createElement('input');
      nameI.type = 'text';
      nameI.placeholder = 'ชื่อ (a-z 0-9 - _)';
      const cmdI = document.createElement('input');
      cmdI.type = 'text';
      cmdI.placeholder = 'คำสั่ง เช่น npx';
      const argsI = document.createElement('textarea');
      argsI.rows = 2;
      argsI.placeholder = 'อาร์กิวเมนต์ บรรทัดละตัว';
      const envI = document.createElement('textarea');
      envI.rows = 2;
      envI.placeholder = 'env บรรทัดละ K=V (ไม่บังคับ)';
      const cwdI = document.createElement('input');
      cwdI.type = 'text';
      cwdI.placeholder = 'โฟลเดอร์ทำงาน สัมพัทธ์กับโปรเจกต์ (ไม่บังคับ)';
      const scopeS = document.createElement('select');
      for (const [v, text] of [['home', 'ทุกโปรเจกต์'], ['project', 'เฉพาะโปรเจกต์นี้']]) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = text;
        scopeS.append(opt);
      }
      const riskS = document.createElement('select');
      for (const [v, text] of [['write', 'เขียน — ผ่านการถามตามโหมด'], ['read', 'อ่านอย่างเดียว — ไม่ถามเลย']]) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = text;
        riskS.append(opt);
      }

      const form = el('div', 'set-group');
      form.append(el('div', 'set-title', 'เพิ่มเซิร์ฟเวอร์'));
      form.append(sheet.row('ชื่อ', 'ใช้เป็นส่วนหนึ่งของ marker: MCP__ชื่อ__tool', nameI));
      form.append(sheet.row('คำสั่ง', 'โปรแกรมที่พูด MCP ผ่าน stdio', cmdI));
      form.append(sheet.row('อาร์กิวเมนต์', 'ทีละตัวต่อบรรทัด', argsI));
      form.append(sheet.row('env', 'บรรทัดละ K=V', envI));
      form.append(sheet.row('โฟลเดอร์ทำงาน', 'ไม่บังคับ — เซิร์ฟเวอร์ที่อ่าน path สัมพัทธ์จะอ้างจากที่นี่', cwdI));
      form.append(sheet.row('ขอบเขต', 'ชื่อซ้ำกัน: โปรเจกต์นี้ทับค่าส่วนกลางเสมอ', scopeS));
      form.append(sheet.row('ความเสี่ยง', 'MCP tool คือโปรแกรมของคนอื่น — ค่าเริ่มต้นคือ "เขียน" ให้ผ่านการถาม', riskS));

      const readForm = () => {
        const env = {};
        for (const l of envI.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
          const eq = l.indexOf('=');
          if (eq < 1) throw new Error(`env ต้องเป็น K=V: "${l}"`);
          env[l.slice(0, eq)] = l.slice(eq + 1);
        }
        const params = {
          name: nameI.value.trim(),
          command: cmdI.value.trim(),
          args: argsI.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean),
          env,
          // A select always has a value in the browser; the fallbacks are for
          // the answer this form gives when nothing was ever chosen.
          risk: riskS.value || 'write',
          scope: scopeS.value || 'home',
        };
        if (cwdI.value.trim()) params.cwd = cwdI.value.trim();
        return params;
      };

      const fout = el('div', 'plugin-source dim');
      const testBtn = el('button', null, 'ทดสอบ');
      testBtn.onclick = async () => {
        let params;
        try { params = readForm(); } catch (e) { fout.className = 'plugin-source err-text'; fout.textContent = e.message; return; }
        testBtn.disabled = true;
        fout.className = 'plugin-source dim';
        fout.textContent = 'กำลังเชื่อมต่อ…';
        const r = await rpc('mcp.test', params).catch((e) => ({ ok: false, error: e.message }));
        fout.className = r.ok ? 'plugin-source ok-text' : 'plugin-source err-text';
        fout.textContent = r.ok
          ? `เชื่อมต่อได้ — ${r.tools.length} tools${r.tools.length ? `: ${r.tools.map((t) => t.name).join(', ')}` : ''}`
          : `err: ${r.error}`;
        testBtn.disabled = false;
      };
      const saveBtn = el('button', 'primary', 'บันทึก');
      saveBtn.onclick = async () => {
        let params;
        try { params = readForm(); } catch (e) { fout.className = 'plugin-source err-text'; fout.textContent = e.message; return; }
        saveBtn.disabled = true;
        const res = await rpc('mcp.add', params).catch((e) => {
          fout.className = 'plugin-source err-text';
          fout.textContent = `err: ${e.message}`;
          return null;
        });
        saveBtn.disabled = false;
        if (res) { live = res; paintMcp(); }
      };
      const btnRow = el('div', 'plugin-actions');
      btnRow.append(testBtn, saveBtn);
      form.append(btnRow, fout);
      wrap.append(form);
    };

    paintMcp();
};
const renderRulesTab = async (page, sheet) => {    sheet.draft.rules = Array.isArray(sheet.draft.rules) ? sheet.draft.rules : [];
    page.append(el('p', 'settings-empty',
      'กฎถูกเช็คก่อนโหมดเสมอ — กฎเองก่อน · `docs/** → อนุญาต` = เลิกถามเรื่องไฟล์ใน docs · '
      + '`.env* → ห้าม` = ล็อก secrets ไม่ให้เขียนแม้ในโหมด yolo · `**` ข้ามโฟลเดอร์ได้ `*` ไม่ได้ · '
      + 'ทีละ pattern เพียง 1 กฎ — กฎแรกที่ match ชนะ'));
    const group = el('div', 'set-group');

    // The same glob the engine uses, copied on purpose: a tester that matched
    // differently from the gate would prove nothing at all.
    const globMatch = (pattern, text) => new RegExp('^' + String(pattern)
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '.*') + '$', 'i').test(text);

    const probe = document.createElement('input');
    probe.type = 'text';
    probe.placeholder = 'ลองพิมพ์ path — .env.local';
    const probeKind = document.createElement('select');
    for (const [v, text] of [['write', 'แก้ไฟล์'], ['run', 'รันคำสั่ง']]) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = text;
      probeKind.append(opt);
    }
    const verdict = el('span', 'rule-verdict dim', 'ยังไม่ทดสอบ');
    const drawVerdict = () => {
      const p = probe.value.trim().split(/\s+/)[0] ?? '';
      if (!p) { verdict.textContent = 'ยังไม่ทดสอบ'; verdict.className = 'rule-verdict dim'; return; }
      const kind = probeKind.value;
      const idx = sheet.draft.rules.findIndex((r) => r.pattern
        && globMatch(r.pattern, p)
        && (!(r.kinds ?? []).length || r.kinds.includes(kind)));
      if (idx === -1) {
        verdict.textContent = `ไม่มีกฎ — ${p} ไปใช้โหมดที่ตั้งไว้`;
        verdict.className = 'rule-verdict dim';
        return;
      }
      const r = sheet.draft.rules[idx];
      const label = { allow: 'อนุญาต (ไม่ถาม)', deny: 'ห้ามหยุดอยู่ ๆ', ask: 'ถามก่อน' }[r.decision ?? 'ask'];
      verdict.textContent = `กฎที่ ${idx + 1} (${r.pattern}) → ${label}`;
      verdict.className = `rule-verdict ${r.decision === 'allow' ? 'ok' : r.decision === 'deny' ? 'bad' : ''}`;
    };
    probe.oninput = drawVerdict;
    probeKind.onchange = drawVerdict;

    const tester = el('div', 'rule-test');
    tester.append(probe, probeKind, verdict);
    group.append(tester);

    const list = el('div', 'set-group');
    const redraw = () => {
      list.textContent = '';
      if (!sheet.draft.rules.length) {
        list.append(el('p', 'settings-empty', 'ยังไม่มีกฎ — ทุกอย่างไปใช้โหมดที่เลือกข้างบน · กด “เพิ่มกฎ” เอาอันแรก'));
      }
      sheet.draft.rules.forEach((rule, i) => {
        const row = el('div', 'rule-row');
        row.append(el('span', 'rule-index', String(i + 1)));
        const pattern = document.createElement('input');
        pattern.type = 'text';
        pattern.value = rule.pattern ?? '';
        pattern.placeholder = 'docs/** · .env* · src/**/*.test.*';
        pattern.oninput = () => { rule.pattern = pattern.value; drawVerdict(); };
        const decision = document.createElement('select');
        for (const [v, text] of [['allow', 'อนุญาต'], ['deny', 'ห้าม'], ['ask', 'ถาม']]) {
          const opt = document.createElement('option');
          opt.value = v;
          opt.textContent = text;
          if ((rule.decision ?? 'ask') === v) opt.selected = true;
          decision.append(opt);
        }
        decision.onchange = () => { rule.decision = decision.value; drawVerdict(); };
        const kinds = document.createElement('select');
        for (const [v, text] of [['', 'ทุกอย่าง'], ['write,replace,delete,move', 'แก้ไฟล์'], ['run', 'รันคำสั่ง']]) {
          const opt = document.createElement('option');
          opt.value = v;
          opt.textContent = text;
          if ((rule.kinds ?? []).join(',') === v) opt.selected = true;
          kinds.append(opt);
        }
        kinds.onchange = () => { rule.kinds = kinds.value ? kinds.value.split(',') : undefined; drawVerdict(); };
        const del = el('button', 'mini', 'ลบ');
        del.onclick = () => { sheet.draft.rules.splice(i, 1); redraw(); };
        row.append(pattern, decision, kinds, del);
        list.append(row);
      });
    };
    redraw();
    group.append(list);
    const add = el('button', null, 'เพิ่มกฎ');
    add.onclick = () => { sheet.draft.rules.push({ pattern: '', decision: 'ask' }); redraw(); };
    group.append(add);
    page.append(group);
};
const renderHealthTab = async (page, sheet) => {    // One button, same answers as the terminal: bridge up, extension
    // attached, quota figures — plus the fix for whatever is red. `status`
    // is token-free by design; `credits` rides the bridge cache so an idle
    // check does not poke the tab upstream.
    const out = el('div', 'set-group');
    const lines = el('div', 'dim', 'ยังไม่ได้ตรวจ — กดปุ่มด้านล่าง');
    out.append(lines);
    const run = el('button', 'primary', 'ตรวจตอนนี้');
    run.onclick = async () => {
      run.disabled = true;
      lines.textContent = '';
      lines.className = 'dim';
      try {
        const st = await rpc('status');
        const credits = await rpc('credits', { force: false }).catch(() => null);
        const rows = [
          ['bridge', st?.bridge ? 'พร้อม' : 'ไม่พร้อม', st?.bridge ? '' : 'รัน aipass dev หรือเปิดแอปใหม่'],
          ['extension', (st?.extensions ?? 0) > 0 ? `เชื่อมอยู่ ×${st.extensions}` : (st?.extensionToken === 'missing' ? 'ยังไม่มี (bridge ไม่ให้ token)' : 'ยังไม่มี'), (st?.extensions ?? 0) > 0 ? '' : (st?.extensionToken === 'missing' ? 'วาง token จาก ~/.aipass/.token ใน popup ของ extension' : 'โหลดโฟลเดอร์ aipass-bridge/extension ใน chrome://extensions')],
          ['tab', state.needsTab ? 'ยังไม่มี — run ล่าสุดขอ tab' : 'พร้อม (หรือยังไม่เคยขอ)', state.needsTab ? 'กด “เปิดให้” จาก welcome card' : ''],
          ['credits', credits ? `${credits.available} / ${credits.limit}` : 'ไม่ทราบ (ไม่มี tab)', credits && Number(credits.available) <= 0 ? 'รอรอบถัดไป หรือใช้โมเดล free-credit' : ''],
          ['build', st?.app ?? 'ไม่ทราบ', ''],
        ];
        for (const [k, v, fix] of rows) {
          const line = el('div', null, `${k}: ${v}${fix ? ` — ${fix}` : ''}`);
          lines.append(line);
        }
      } catch (err) {
        lines.className = 'install-out err';
        lines.textContent = `ตรวจไม่ได้: ${friendly(err.message)}`;
      }
      run.disabled = false;
    };
    page.append(out, run);
};

/**
 * The hooks tab: the person's own commands, at the moments that matter.
 *
 * A hook is a command line the person wrote, run by the harness at a named
 * moment — before a call runs, when a session or a task starts, after a
 * change is staged, before a commit, or when the run ends. The command's
 * verdict comes back to the model (and, for the end moments, to the person as
 * a note), so "run the linter after every edit" is a setting rather than a
 * habit.
 *
 * @param {object} page
 * @param {object} sheet
 */
const renderHooksTab = async (page, sheet) => {
  const group = el('div', 'set-group');
  group.append(sheet.row('ตอนเริ่มบทสนทนา (sessionStart)',
    'รันครั้งเดียวก่อนงานแรกของบทสนทนา — ผลถูกส่งให้โมเดลเป็นบริบทจากคุณ ไม่ใช่คำสั่งของโปรเจกต์',
    sheet.control({ key: 'hooks.sessionStart', type: 'textarea' })));
  group.append(sheet.row('ตอนส่งงาน (promptSubmit)',
    'รันก่อนทุกงานที่คุณส่ง — ผลถูกส่งให้โมเดลเป็นบริบทจากคุณ',
    sheet.control({ key: 'hooks.promptSubmit', type: 'textarea' })));
  group.append(sheet.row('ก่อนใช้เครื่องมือ (beforeTool)',
    'รันก่อนทุกเครื่องมือ — exit ที่ไม่ใช่ 0 จะปฏิเสธ call นั้น และทุกโหมดต้องเคารพ',
    sheet.control({ key: 'hooks.beforeTool', type: 'textarea' })));
  group.append(sheet.row('หลังใช้เครื่องมือ (afterTool)',
    'รันหลังทุกเครื่องมือ — สิ่งที่พิมพ์ถูกต่อท้ายผลลัพธ์ที่โมเดลอ่าน',
    sheet.control({ key: 'hooks.afterTool', type: 'textarea' })));
  group.append(sheet.row('หลังแก้ไฟล์ (afterWrite)',
    'รันคำสั่งนี้ทุกครั้งที่รันเตรียมการแก้ไฟล์ — เช่น "npm run lint" — ผลของคำสั่งกลับไปหาโมเดล',
    sheet.control({ key: 'hooks.afterWrite', type: 'textarea' })));
  group.append(sheet.row('ก่อน commit (beforeCommit)',
    'รันก่อน commit — ถ้าคำสั่งล้มเหลว commit จะไม่เกิดขึ้น',
    sheet.control({ key: 'hooks.beforeCommit', type: 'textarea' })));
  group.append(sheet.row('ก่อนบีบบริบท (preCompact)',
    'รันก่อนสรุปบทสนทนาและเริ่ม conversation ใหม่ — ผลถูกรวมไว้ใน summary',
    sheet.control({ key: 'hooks.preCompact', type: 'textarea' })));
  group.append(sheet.row('ตอนจบรัน (done)',
    'รันตอนรันจบ — ผลขึ้นที่คนใช้เป็นบันทึกในบทสนทนา',
    sheet.control({ key: 'hooks.done', type: 'textarea' })));
  group.append(sheet.row('ตอนหยุดกลางทาง (stop)',
    'รันเมื่อรันจบโดยไม่ได้ DONE (หยุดเอง เกินงบ หรือตัน) — ผลขึ้นเป็นบันทึก',
    sheet.control({ key: 'hooks.stop', type: 'textarea' })));
  page.append(group);
  const note = el('p', 'settings-empty');
  note.append('คำสั่งหนึ่งบรรทัดต่อ hook — เช่น "npm run lint" หรือ "npm test" · คำสั่งที่ล้มเหลวจะถูกบอก ไม่ทำให้รันตาย');
  page.append(note);
};

/**
 * The hooks save: all nine moments, and nothing else.
 *
 * @param {object} sheet
 * @returns {TabSave}
 */
const saveHooksTab = (sheet) => ({ patch: { hooks: sheet.draft.hooks ?? {} }, problems: [] });

const TABS = [
  {
    id: 'model',
    icon: '🤖',
    title: 'คุยกับโมเดล',
    // The mode (สิทธิ์/plan) is deliberately NOT a row here: it decides what
    // the NEXT message may do, so it lives beside the composer where the
    // message is written — one surface per control, or two copies drift.
    sub: 'โมเดล temperature และขีดจำกัดของแต่ละรัน — โหมดการทำงาน (สิทธิ์/plan) อยู่ข้างช่องพิมพ์ที่หน้าแชต',
    save: saveModelTab,
    fields: [
      { key: 'defaultModel', label: 'โมเดลเริ่มต้น', type: 'text', note: 'id ของโมเดล — ดูรายการได้ที่ /models หรือกดที่หัวหน้าต่าง' },
      { key: 'temperature', label: 'temperature (ความสุ่มของคำตอบ)', type: 'select', options: [
        ['default', 'default — ปล่อยตามค่าเริ่มต้นของแต่ละโมเดล'],
        ['0', '0 — นิ่ง ตอบเหมือนเดิมทุกครั้ง'],
        ['0.3', '0.3 — ต่ำ เหมาะกับงานโค้ด'],
        ['0.7', '0.7 — สมดุล'],
        ['1', '1.0 — หลากหลายขึ้น'],
        ['1.5', '1.5 — สูง'],
        ['2', '2.0 — สุ่มสูงสุด'],
      ], note: 'ยิ่งต่ำยิ่งคงที่ ยิ่งสูงยิ่งหลากหลาย — งานที่ต้องแม่นใช้ต่ำ งานร่างไอเดียใช้สูงได้' },
      { key: 'allowRun', label: 'อนุญาตให้รันคำสั่ง shell', type: 'checkbox', note: 'ปิด = โมเดลแก้ไฟล์ได้อย่างอื่นไม่ได้' },
      { key: 'allowGitWrite', label: 'ให้โมเดลเขียน git ได้ (ปิดไว้เป็นค่าเริ่มต้น)', type: 'checkbox', note: 'โมเดลสั่ง GIT stage/commit/branch เองได้ — ยังถามก่อนตามโหมดสิทธิ์เหมือนเดิม' },
      { key: 'allowVerify', label: 'ให้โมเดลใช้ marker VERIFY ได้ (ปิดไว้เป็นค่าเริ่มต้น)', type: 'checkbox', note: 'โมเดลขอรันเช็คของโปรเจกต์เองได้ (VERIFY) — คำสั่งเช็คเป็นงาน shell จึงถูกถามตามโหมดสิทธิ์' },
      { key: 'maxSteps', label: 'สูงสุดกี่ Step ต่อคำสั่ง', type: 'number', note: '0 = ไม่จำกัด — งานยาวไปจนจบ; เบรกจริงคือ budget ด้านล่าง (tool calls / เวลา)' },
      { key: 'maxToolCalls', label: 'สูงสุดกี่ tool call ต่อคำสั่ง', type: 'number', note: 'เพดานกันหลุด — คำตอบเดียวที่สั่งเครื่องมือร้อยครั้งจะหยุดเมื่อถึงตัวเลขนี้ (ค่าเริ่มต้น 300)' },
      { key: 'maxWallClockMin', label: 'เวลาสูงสุดต่อคำสั่ง (นาที)', type: 'number', note: 'เพดานเวลา — งานที่ค้างจะหยุดเอง (ค่าเริ่มต้น 30)' },
      { key: 'maxCredits', label: 'เพดานเครดิตต่อคำสั่ง', type: 'number', note: '0 = ไม่จำกัด — หยุดงานเมื่อใช้เครดิตถึงเพดาน (เช็คกับยอดที่แคชไว้ ~30 วิ ต่อครั้ง)' },
      { key: 'maxResult', label: 'สูงสุดกี่ byte ต่อผลเครื่องมือ', type: 'number', note: '0 = ค่าเริ่มต้น (3000) — ที่เหลือ spill ลงดิสก์ให้อ่านต่อได้; ใหญ่ขึ้น = รอบน้อยลง' },
      { key: 'subagent', label: 'ให้เรียก helper ย่อย', type: 'checkbox', note: 'งานยาวถูกแบ่งให้ตัวช่วย แล้วรีพอร์ตกลับ' },
      { key: 'replyLanguage', label: 'ภาษาที่ตอบผู้ใช้', type: 'select', options: [['th', 'ไทย — ค่าเริ่มต้น'], ['en', 'English']], note: 'โค้ด คำสั่ง และพาธเป็นอังกฤษเสมอ ไม่ว่าตัวนี้จะตั้งไว้อย่างไร' },
      { key: 'langCheck', label: 'เตือนเมื่อลืมตอบไทย', type: 'checkbox', note: 'ตรวจสัดส่วนอักษรไทยของข้อความปิดงานก่อนรับ DONE — เตือนหนึ่งครั้ง' },
      { key: 'minThaiRatio', label: 'สัดส่วนอักษรไทยขั้นต่ำ', type: 'number', note: '0-1 (ค่าเริ่มต้น 0.4) — ไม่นับบล็อกโค้ด/ลิงก์' },
      { key: 'repeatGuard', label: 'กันเรียกซ้ำซาก', type: 'checkbox', note: 'เรียก tool เดิม + อาร์กิวเมนต์เดิมครั้งที่สามโดยไม่มีอะไรเปลี่ยน = ถูกบล็อกพร้อมคำแนะนำ' },
      { key: 'repeatGuardMax', label: 'เพดานการบล็อกซ้ำต่อรอบ', type: 'number', note: 'เกินแล้วหยุดรอบเป็น stalled (ค่าเริ่มต้น 4)' },
      { key: 'attempts', label: 'รอบลองสูงสุดต่อคำสั่ง', type: 'number', note: 'ลองซ้ำเมื่อ checker ไม่ผ่าน (1 = ไม่ลอง; ทุกรอบคิดเครดิตเต็ม)' },
      { key: 'verifyCommand', label: 'คำสั่งตรวจ (verify command)', type: 'text', note: 'ถ้าใส่ จะใช้แทน .aipass/check.txt และบันทึกมากับผลตรวจ — เว้นว่าง = ใช้ไฟล์ของโปรเจกต์' },
      { key: 'requireCheck', label: 'บังคับให้ check ผ่านก่อน DONE', type: 'checkbox', note: 'ถ้ามีคำสั่งตรวจและ checker ยัง fail จะไม่รับ DONE — หยุดเป็น done-unverified' },
    ],
  },
  { id: 'context', icon: '📊', title: 'บริบท (context)', sub: 'งบ token และจังหวะการบีบเอ็น', custom: 'context', render: renderContextTab, save: saveContextTab },
  { id: 'providers', icon: '🌐', title: 'ผู้ให้บริการ', sub: 'ใครตอบรัน — AiPASS (ผ่าน bridge) หรือ API อื่น', custom: 'providers', render: renderProvidersTab, save: saveEmptyTab },
  // The three pages that act on the machine instead of describing it. They
  // are the HUMAN's buttons: a commit is a person clicking, not a model
  // asking, and the permission mode of a run has nothing to do with them.
  { id: 'git', icon: '🌿', title: 'git', sub: 'สถานะ repo — stage / commit / branch ของคุณเอง', custom: 'git', render: renderGitTab, save: saveEmptyTab },
  { id: 'media', icon: '🎨', title: 'สร้างสื่อ', sub: 'รูป วิดีโอ และเสียงจากโมเดลสื่อ', custom: 'media', render: renderMediaTab, save: saveEmptyTab },
  { id: 'schedule', icon: '⏰', title: 'ตารางเวลา', sub: 'งานที่ทำตามเวลา — ต้องมี bridge และแท็บที่ล็อกอินอยู่', custom: 'schedule', render: renderScheduleTab, save: saveEmptyTab },
  { id: 'memory', icon: '🧠', title: 'ความจำข้ามเซสชัน', sub: 'สิ่งที่แอปจำไว้จากบทสนทนาก่อน ๆ — ดูได้ ลบได้ทันที', custom: 'memory', render: renderMemoryTab, save: saveEmptyTab },
  { id: 'goal', icon: '🎯', title: 'เป้าหมาย (goal)', sub: 'เป้าหมายระยะยาวของโปรเจกต์ — ทุก run เห็นข้อความเดียวกัน', custom: 'goal', render: renderGoalTab, save: saveEmptyTab },
  { id: 'window', icon: '🪟', title: 'หน้าต่าง', sub: 'ธีมและหน้า chat ที่ใช้เชื่อมต่อ', save: saveWindowTab, fields: [
    { key: 'theme', label: 'ธีม', type: 'select', options: [['dark', 'มืด'], ['light', 'สว่าง'], ['auto', 'ตามเครื่อง']], note: 'สลับดูได้ทันทีตอนเลือก' },
    { key: 'chatUrl', label: 'หน้า chat ที่ล็อกอินอยู่', type: 'text', note: 'bridge ใช้ tab นี้พูดกับโมเดล' },
    { key: 'autoOpenTab', label: 'เปิด tab ให้เองเมื่อต้องการ', type: 'checkbox', note: 'run ที่ไม่มี tab จะเปิดบราวเซอร์ให้แทนที่จะพัง' },
  ] },
  { id: 'skills', icon: '📘', title: 'คู่มือ (playbook)', sub: 'โฟลเดอร์ที่ใช้ค้นหาคู่มือ', custom: 'skillsDirs', render: renderSkillsDirsTab, save: saveSkillsTab },
  { id: 'rules', icon: '🛡️', title: 'กฎไฟล์', sub: 'path ที่มีกฎละเว้นโหมด — first match wins', custom: 'rules', render: renderRulesTab, save: saveRulesTab },
  { id: 'hooks', icon: '🪝', title: 'hooks (คำสั่งของคุณ)', sub: 'คำสั่งที่รันเอง — ตั้งแต่เริ่มบทสนทนา ก่อน/หลังเครื่องมือ ถึงตอนจบ', custom: 'hooks', render: renderHooksTab, save: saveHooksTab },
  // Health is pull-based on purpose (docs/RELIABILITY.md): no daemon pages
  // anyone, so the check lives where the person already looks — one button,
  // same answers as `aipass doctor` + `npm run stats -- --alerts`.
  { id: 'health', icon: '🩺', title: 'สุขภาพ', sub: 'bridge · extension · tab · credits — กดตรวจตอนนี้', custom: 'health', render: renderHealthTab, save: saveEmptyTab },
];
/**
 * The settings sheet — a category rail on the left, one page of settings on the
 * right, so a section you never touch is one click away instead of one scroll
 * away. What the older sheet got right, this keeps: edits are staged in a draft
 * and only "บันทึก" writes them, validation names the problem instead of saving
 * a bad number, and the context meter ticks live while the sheet is open.
 */
async function openSettings() {
  const settings = await rpc('settings.get').catch(() => null);
  if (!settings) { addNote('อ่านการตั้งค่าไม่ได้'); return; }
  state.settings = settings;

  const draft = structuredClone(settings);
  draft.compaction = { contextTokens: 24000, reserveTokens: 4096, keepRecentBytes: 6000, ...(settings.compaction ?? {}) };
  // The wall-clock budget is stored in milliseconds; the sheet asks in
  // minutes, because typing 1800000 to mean half an hour is a trap.
  draft.maxWallClockMin = Math.max(1, Math.round(Number(settings.maxWallClockMs ?? 1_800_000) / 60_000));
  // The temperature select speaks in strings; null — "the model's own
  // default" — is what the option named 'default' shows.
  draft.temperature = settings.temperature == null ? 'default' : String(settings.temperature);

  $('modal-title').textContent = 'การตั้งค่า';
  $('modal').classList.add('settings-sheet');
  const body = $('modal-body');
  body.textContent = '';

  const read = (key) => key.split('.').reduce((o, k) => (o ?? {})[k], draft);
  const write = (key, value) => {
    if (!key.includes('.')) { draft[key] = value; return; }
    const [head, tail] = key.split('.');
    draft[head] = { ...(draft[head] ?? {}), [tail]: value };
  };

  const control = (field) => {
    const value = read(field.key);
    if (field.type === 'checkbox') {
      const lab = el('label', 'switch');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = Boolean(value);
      box.onchange = () => write(field.key, box.checked);
      lab.append(box, el('span', 'track'));
      return lab;
    }
    if (field.type === 'select') {
      const select = document.createElement('select');
      for (const [v, text] of field.options) {
        const opt = document.createElement('option');
        opt.value = v;
        opt.textContent = text;
        if (v === value) opt.selected = true;
        select.append(opt);
      }
      select.onchange = () => {
        write(field.key, select.value);
        // The theme shows its effect immediately: a setting you have to save
        // before you can see it is a setting you guess at.
        if (field.key === 'theme') applyTheme(select.value);
      };
      return select;
    }
    if (field.type === 'textarea') {
      const area = document.createElement('textarea');
      area.rows = 4;
      area.value = Array.isArray(value) ? value.join('\n') : String(value ?? '');
      area.oninput = () => write(field.key, area.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
      return area;
    }
    const input = document.createElement('input');
    input.type = field.type;
    input.value = value ?? '';
    if (field.type === 'number') input.min = '0';
    input.onchange = () => write(field.key, field.type === 'number' ? Number(input.value) : input.value);
    return input;
  };

  // One labelled row: title + note on the left, control on the right. `stack`
  // drops the control underneath — a textarea in a side-by-side row would be
  // 300px wide for four lines of paths.
  const row = (label, note, node) => {
    const r = el('div', 'set-row');
    const info = el('div', 'set-info');
    info.append(el('div', 'set-title', label));
    if (note) info.append(el('div', 'set-note', note));
    const c = el('div', 'set-control');
    if (node.tagName === 'TEXTAREA') r.classList.add('stack');
    c.append(node);
    r.append(info, c);
    return r;
  };

  const details = await rpc('plugins.list').catch(() => null);
  // The MCP section is live connection state, not a file — it only means
  // something when the backend answers mcp.list with rows (an older backend,
  // or a test stub, answers nothing useful and gets no section).
  const mcpList = await rpc('mcp.list').catch(() => null);
  const mcpReady = mcpList && Array.isArray(mcpList.servers) ? mcpList : null;
  // The sheet every tab draws into: the draft the edits land in, the helpers
  // that read and write it, and the two answers only the backend has. The
  // window's own helpers ride along too, so a page that acts on the machine
  // (git, media, the schedule) can talk to it the way the other pages do.
  const sheet = { draft, read, write, control, row, details, mcpReady, rpc, el, state, addNote, addCommandOut, friendly };
  const tabs = details
    ? [...TABS,
      { id: 'plugins', icon: '🧩', title: 'ปลั๊กอิน', sub: `โค้ดเสริมจาก ${details.dir}`, custom: 'plugins', render: renderPluginsTab, save: saveEmptyTab },
      ...(mcpReady ? [{ id: 'mcp', icon: '🔌', title: 'MCP', sub: 'เซิร์ฟเวอร์เครื่องมือภายนอก — เพิ่ม ปิด ทดสอบ', custom: 'mcp', render: renderMcpTab, save: saveEmptyTab }] : [])]
    : TABS;

  const nav = el('nav', 'settings-nav');
  const pages = el('div', 'settings-pages');
  const show = (id) => {
    for (const b of nav.querySelectorAll('button')) b.classList.toggle('active', b.dataset.cat === id);
    for (const p of pages.querySelectorAll('.settings-page')) p.classList.toggle('active', p.dataset.page === id);
  };



  for (const tab of tabs) {
    const button = el('button');
    button.dataset.cat = tab.id;
    button.append(el('span', 'nav-icon', tab.icon), el('span', null, tab.title));
    button.onclick = () => show(tab.id);
    nav.append(button);

    const page = el('section', 'settings-page');
    page.dataset.page = tab.id;
    page.append(el('h4', 'settings-page-title', tab.title));
    page.append(el('p', 'settings-page-sub', tab.sub));
    pages.append(page);

    if (tab.custom) { await tab.render(page, sheet); continue; }
    const group = el('div', 'set-group');
    for (const field of tab.fields ?? []) group.append(sheet.row(field.label, field.note, sheet.control(field)));
    page.append(group);
  }
  show(tabs[0].id);
  const root = el('div', 'settings');
  root.append(nav, pages);
  body.append(root);

  // Inserted, not just built: a Save that says nothing when it refuses is the
  // same silence the sheet exists to prevent.
  const error = el('p', 'settings-error hidden');
  body.append(error);

  const actions = $('modal-actions');
  actions.textContent = '';

  const reset = el('button', null, 'คืนค่าเดิม');
  reset.onclick = async () => {
    const done = await rpc('settings.reset').catch((err) => ({ error: err.message }));
    if (done.error) { error.textContent = friendly(done.error); error.classList.remove('hidden'); return; }
    hideModal();
    openSettings();
    addCommandOut('คืนการตั้งค่าทั้งหมดเป็นค่าเริ่มต้นแล้ว');
  };

  const save = el('button', 'primary', 'บันทึก');
  save.onclick = async () => {
    // Every tab is asked what it would write, and what is wrong with it.
    // Nothing is written while one of them has a problem.
    const patch = {};
    const problems = [];
    for (const tab of tabs) {
      const out = tab.save?.(sheet) ?? { patch: {}, problems: [] };
      Object.assign(patch, out.patch ?? {});
      problems.push(...(out.problems ?? []));
    }
    if (problems.length) { error.textContent = problems.join(' · '); error.classList.remove('hidden'); return; }
    error.classList.add('hidden');
    const next = await rpc('settings.set', patch).catch((err) => ({ error: err.message }));
    if (next.error) { error.textContent = next.error; error.classList.remove('hidden'); return; }
    state.settings = next;
    applyTheme(next.theme);
    hideModal();
    await refreshHeader();
    // The playbook library is rebuilt by the backend when skillsDirs changes,
    // and the settings sheet lists what the folders hold — so the window asks
    // again, and the list is right the next time the sheet opens.
    await refreshSkills();
    applySettingsToUi(state.settings);
    // The two switches the harness option sheet owns: a backend that does not
    // know the key drops it (rpc/settings.mjs writes only the keys DEFAULTS
    // knows), and the window says so rather than showing a switch that
    // quietly does nothing.
    const dropped = ['allowGitWrite', 'allowVerify']
      .filter((key) => patch[key] !== undefined && next[key] !== patch[key]);
    addCommandOut(dropped.length
      ? `บันทึกการตั้งค่าแล้ว · ค่า ${dropped.join(', ')} ยังไม่มีผล — backend รุ่นนี้ยังไม่รองรับตัวเลือกนี้`
      : 'บันทึกการตั้งค่าแล้ว');
  };

  const close = el('button', null, 'ปิด');
  close.onclick = () => { hideModal(); applyTheme(state.settings?.theme ?? 'dark'); };
  actions.append(error, reset, close, save);
  openModal();

  // The meter follows the live session while the sheet is open. The timer is
  // module-level so closing the sheet can stop it: it used to be written into
  // the modal's dataset and never read, so every "คืนค่าเดิม" — which closes
  // the sheet and opens it again — left another one polling the backend
  // forever.
  if (ctx.meterTimer) clearInterval(ctx.meterTimer);
  ctx.meterTimer = setInterval(async () => {
    if ($('modal').classList.contains('hidden')) { clearInterval(ctx.meterTimer); ctx.meterTimer = null; return; }
    const live = await rpc('status').catch(() => null);
    const bar = $('ctx-bar');
    if (!bar) { clearInterval(ctx.meterTimer); ctx.meterTimer = null; return; }
    const pct = live?.context?.percent ?? 0;
    bar.className = `ctx-bar ${pct >= 85 ? 'full' : pct >= 60 ? 'warm' : ''}`;
    bar.style.setProperty('--pct', `${pct}%`);
    bar.title = `${pct}% ของงบบริบท`;
  }, 2000);
}


/**
 * Apply the theme for real. `theme` sat in settings doing nothing at all — a
 * setting that changes nothing is worse than no setting, because it looks like
 * a feature and behaves like a lie.
 */



  return { openSettings };
}

export default createSettings;
