// The work surfaces of the settings sheet: git, media and the schedule.
//
// Three pages that are not settings at all — they are the machine's own
// buttons, and they live in the sheet because the sheet is where the rest of
// the app's surfaces are:
//
//   - GIT      the repository's state, and the buttons that stage, commit and
//              branch. These are the HUMAN's calls: they never consult the
//              model's permission mode, and the window asks before it commits.
//   - สื่อ      the media models of the live catalog, the options the chosen
//              one accepts, and the render itself.
//   - ตารางเวลา the tasks this machine runs at a time of day.
//
// Every page here answers with what the backend said. Nothing is invented: a
// page that cannot reach the backend says so instead of showing an empty box
// that reads like a broken feature.

/** The last folder of a path — a project named by its folder, not its path. */
const folderName = (root) => String(root ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(root ?? '');

/** An <option>, built the way the page builds them (no globals to rely on). */
const optionEl = (value, text) => {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = text;
  return opt;
};

/* ------------------------------------------------------------------- git */

/**
 * The git page: the repository's state, and the buttons that act on it.
 *
 * A commit is a person clicking, not a model asking — so nothing here
 * consults the model's permission mode, and the window asks before it commits:
 * a commit lands in the repository's history, and no button in the app can
 * undo that.
 */
export async function renderGitTab(page, sheet) {
  const { el, rpc, state, addCommandOut, friendly } = sheet;

  const head = el('div', 'plugin-head');
  const branch = el('div', 'plugin-name', 'กำลังอ่านสถานะ…');
  head.append(branch);
  const note = el('div', 'install-out dim', '');
  page.append(head, note);

  const lists = el('div', 'set-group');
  page.append(lists);

  /** The three lists the repository is made of. */
  const paintLists = async () => {
    const st = await rpc('git.status').catch((err) => ({ error: err.message }));
    if (st.error) {
      branch.textContent = 'อ่านสถานะ git ไม่ได้';
      lists.textContent = '';
      lists.append(el('p', 'install-out err', friendly(st.error)));
      return null;
    }
    state.git = st;
    branch.textContent = `branch: ${st.branch ?? '(ไม่ทราบ)'}${st.clean ? ' · สะอาด ไม่มีอะไรค้าง' : ''}`;
    lists.textContent = '';
    for (const [label, rows] of [['staged', st.staged], ['unstaged', st.unstaged], ['untracked', st.untracked]]) {
      const box = el('div', 'set-group');
      box.append(el('div', 'set-title', `${label} (${(rows ?? []).length})`));
      const list = el('ul', 'list dim');
      for (const file of rows ?? []) {
        const li = el('li');
        li.append(el('span', 'name', file));
        // A staged file is staged already; the button is for the rest.
        if (label !== 'staged') {
          const stage = el('button', 'mini', 'stage');
          // "stage" repeated down the list is one name for many buttons; the
          // file is what tells a screen reader which one it is on.
          stage.setAttribute('aria-label', `stage ${file}`);
          stage.onclick = async () => {
            stage.disabled = true;
            const done = await rpc('git.stage', { paths: [file] }).catch((err) => ({ error: err.message }));
            if (done.error) note.textContent = `stage ไม่สำเร็จ: ${friendly(done.error)}`;
            else note.textContent = '';
            await paintLists();
          };
          li.append(stage);
        }
        list.append(li);
      }
      if (!(rows ?? []).length) list.append(el('li', 'dim', '(ไม่มี)'));
      box.append(list);
      lists.append(box);
    }
    return st;
  };

  await paintLists();

  // The files the pending panel has ticked: the edits a run staged and the
  // person approved, ready to go into the repository's index.
  const ticked = () => [...state.pending.entries()].filter(([, info]) => info.checked).map(([file]) => file);
  const stageTicked = el('button', null, 'stage ไฟล์ที่ติ๊กไว้ในแผงรอเขียน');
  stageTicked.onclick = async () => {
    const files = ticked();
    if (!files.length) { note.textContent = 'ยังไม่มีไฟล์ที่ติ๊กไว้ในแผงรอเขียน'; return; }
    stageTicked.disabled = true;
    const done = await rpc('git.stage', { paths: files }).catch((err) => ({ error: err.message }));
    stageTicked.disabled = false;
    if (done.error) { note.textContent = `stage ไม่สำเร็จ: ${friendly(done.error)}`; return; }
    note.textContent = '';
    addCommandOut(`stage แล้ว ${(done.staged ?? files).length} ไฟล์`);
    await paintLists();
  };

  // The commit. It needs a message — git refuses one without — and the window
  // asks before it commits, because this is the one button here that cannot be
  // taken back by clicking again.
  const message = document.createElement('input');
  message.type = 'text';
  message.placeholder = 'ข้อความของ commit — ว่างไม่ได้';
  message.setAttribute('aria-label', 'ข้อความ commit');
  const commit = el('button', 'primary', 'commit');
  commit.onclick = async () => {
    const text = message.value.trim();
    if (!text) { note.textContent = 'commit ต้องมีข้อความ — git ไม่รับ commit ที่ไม่มีข้อความ'; return; }
    if (!window.confirm(`commit ข้อความว่า "${text}"? — commit เขียนลงประวัติของ repo แล้ว ย้อนกลับยาก`)) return;
    commit.disabled = true;
    const done = await rpc('git.commit', { message: text }).catch((err) => ({ error: err.message }));
    commit.disabled = false;
    if (done.error) { note.textContent = `commit ไม่สำเร็จ: ${friendly(done.error)}`; return; }
    note.textContent = '';
    addCommandOut(`commit แล้ว: ${done.commit ?? ''} — ${(done.files ?? []).length} ไฟล์`);
    message.value = '';
    await paintLists();
  };

  // The branch. It is created, not checked out: the window's tree stays where
  // the person put it.
  const name = document.createElement('input');
  name.type = 'text';
  name.placeholder = 'ชื่อ branch ใหม่ — เช่น feature/แผนงาน';
  name.setAttribute('aria-label', 'ชื่อ branch ใหม่');
  const make = el('button', null, 'สร้าง branch');
  make.onclick = async () => {
    const text = name.value.trim();
    if (!text) { note.textContent = 'ต้องมีชื่อ branch'; return; }
    make.disabled = true;
    const done = await rpc('git.branch', { name: text }).catch((err) => ({ error: err.message }));
    make.disabled = false;
    if (done.error) { note.textContent = `สร้าง branch ไม่สำเร็จ: ${friendly(done.error)}`; return; }
    note.textContent = '';
    addCommandOut(`สร้าง branch แล้ว: ${done.branch ?? text}`);
    name.value = '';
    await paintLists();
  };

  const form = el('div', 'set-group');
  form.append(sheet.row('ไฟล์ที่ stage', 'ไฟล์ที่ติ๊กไว้ในแผงรอเขียนของหน้าต่าง', stageTicked));
  form.append(sheet.row('ข้อความ commit', 'บอกว่าการเปลี่ยนแปลงนี้คืออะไร — ว่างไม่ได้', message));
  form.append(sheet.row('commit', 'เขียนลงประวัติของ repo — หน้าต่างจะถามก่อน', commit));
  form.append(sheet.row('branch ใหม่', 'สร้าง branch (ไม่ได้สลับมาที่ branch ใหม่)', name));
  form.append(sheet.row('สร้าง branch', 'ชื่อต้องเป็นตัวอักษร ตัวเลข ขีด จุด และ / เท่านั้น', make));
  page.append(form);
}

/* ----------------------------------------------------------------- media */

/**
 * The media page: a picture, a clip or a song, made by the model the person
 * picks.
 *
 * Only the options the chosen model accepts are on screen. The backend drops
 * the rest — an option a model does not declare is refused upstream, once the
 * credits are gone — so the page shows what the model takes, and says what was
 * dropped when the render comes back.
 */
export async function renderMediaTab(page, sheet) {
  const { el, rpc, state, addCommandOut, friendly } = sheet;

  page.append(el('p', 'settings-empty',
    'สร้างรูป วิดีโอ หรือเสียงจากโมเดลสื่อของ AiPASS — ไฟล์ที่ได้ถูกเก็บไว้นอกโปรเจกต์ (ไม่ให้เผลอ commit)'));

  const group = el('div', 'set-group');
  page.append(group);

  const catalog = await rpc('media.models').catch(() => null);
  state.media = catalog;
  const models = [];
  for (const [kind, label] of [['image', 'รูป'], ['video', 'วิดีโอ'], ['music', 'เสียง']]) {
    for (const m of catalog?.[kind] ?? []) models.push({ ...m, kind, label });
  }
  if (!models.length) {
    group.append(el('p', 'install-out err', catalog
      ? 'ยังไม่มีโมเดลสื่อในแคตตาล็อก — ต้องมีแท็บ de.aipass.net ที่ล็อกอินอยู่'
      : 'อ่านแคตตาล็อกโมเดลสื่อไม่ได้ — ต้องมี bridge ที่เชื่อมอยู่'));
    return;
  }

  const model = document.createElement('select');
  model.setAttribute('aria-label', 'โมเดลสื่อ');
  for (const m of models) model.append(optionEl(m.id, `${m.label}: ${m.name ?? m.id}`));
  // The pick is named rather than implied: a select with no value is a select
  // the backend refuses.
  model.value = models[0].id;
  group.append(sheet.row('โมเดล', 'โมเดลที่ทำรูป/วิดีโอ/เสียงได้', model));

  // The options the chosen model accepts, and nothing else.
  const options = el('div', 'set-group');
  page.append(options);
  const chosen = {};

  const pick = (label, note, values, key) => {
    const select = document.createElement('select');
    // The row's title is a sibling, so the select carries the name itself.
    select.setAttribute('aria-label', label);
    select.append(optionEl('', '(ไม่ระบุ)'));
    for (const v of values ?? []) select.append(optionEl(String(v), String(v)));
    select.onchange = () => {
      if (select.value) chosen[key] = select.value;
      else delete chosen[key];
    };
    options.append(sheet.row(label, note, select));
  };

  const paintOptions = async () => {
    const res = await rpc('media.options', { model: model.value }).catch(() => null);
    options.textContent = '';
    for (const key of Object.keys(chosen)) delete chosen[key];
    const o = res?.options;
    if (!o) { options.append(el('p', 'settings-empty', 'อ่านตัวเลือกของโมเดลนี้ไม่ได้')); return; }
    if (o.aspectRatio) pick('อัตราส่วน', 'ถ้าโมเดลไม่บอกรายการ ใส่เองได้', o.aspectRatios, 'ratio');
    if (o.resolution) pick('ความละเอียด', 'เช่น 720p หรือ 1080p', o.resolutions, 'resolution');
    if (o.duration) pick('ความยาว (วินาที)', 'ความยาวของคลิป', o.durations, 'duration');
    if (o.style) pick('สไตล์', 'สไตล์ที่บริการให้มา', o.styles, 'style');
    if (o.cameraFixed) {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.setAttribute('aria-label', 'กล้องนิ่ง');
      box.onchange = () => { chosen.cameraFixed = box.checked; };
      options.append(sheet.row('กล้องนิ่ง', 'ให้กล้องอยู่กับที่ (ต้องการตัวเลือกนี้)', box));
    }
    if (o.generateAudio) {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.setAttribute('aria-label', 'เสียงประกอบ');
      box.onchange = () => { chosen.generateAudio = box.checked; };
      options.append(sheet.row('เสียงประกอบ', 'ให้คลิปมีเสียงด้วย', box));
    }
    if (!options.children.length) options.append(el('p', 'settings-empty', 'โมเดลนี้รับแค่คำสั่ง (prompt) เท่านั้น'));
  };

  model.onchange = () => { void paintOptions(); };
  await paintOptions();

  const prompt = document.createElement('textarea');
  prompt.rows = 3;
  prompt.placeholder = 'บอกว่าอยากได้อะไร — เช่น ภาพหนังสือเก่าใต้ฝน หนังสือวาด';
  prompt.setAttribute('aria-label', 'คำอธิบายสิ่งที่อยากได้');
  group.append(sheet.row('คำสั่ง', 'คำอธิบายสิ่งที่อยากได้', prompt));

  const note = el('div', 'install-out dim', '');
  const go = el('button', 'primary', 'สร้าง');
  go.onclick = async () => {
    const ask = prompt.value.trim();
    if (!ask) { note.className = 'install-out err'; note.textContent = 'ต้องมีคำอธิบายว่าอยากได้อะไร'; return; }
    go.disabled = true;
    note.className = 'install-out dim';
    note.textContent = 'กำลังสร้าง… (อาจใช้เวลาเป็นนาที)';
    const done = await rpc('media.generate', { model: model.value, prompt: ask, ...chosen })
      .catch((err) => ({ error: err.message }));
    go.disabled = false;
    if (done.error) { note.className = 'install-out err'; note.textContent = `สร้างไม่สำเร็จ: ${friendly(done.error)}`; return; }
    note.className = 'install-out';
    note.textContent = '';
    note.append(el('div', null, `เสร็จแล้ว — ไฟล์: ${done.path ?? ''}`));
    note.append(el('div', 'dim', `${Math.round(Number(done.bytes ?? 0) / 1024)} KB${done.mime ? ` · ${done.mime}` : ''}`));
    note.append(el('div', 'dim', 'ไฟล์เก็บไว้นอกโปรเจกต์ตามค่าเริ่มต้น — เอาไปใช้ได้จาก path ข้างบน'));
    // What the model would not take is said out loud: a dropped option is
    // money spent for nothing, and the person should know which one it was.
    if ((done.dropped ?? []).length) {
      note.append(el('div', 'warn', `ตัดทิ้ง — โมเดลนี้ไม่รับ: ${done.dropped.join(', ')}`));
    }
    addCommandOut(`สร้างสื่อแล้ว: ${done.path ?? ''}`);
  };
  const actions = el('div', 'plugin-actions');
  actions.append(go);
  page.append(actions, note);
}

/* -------------------------------------------------------------- schedule */

/**
 * The schedule page: the work this machine does at a time of day.
 *
 * The backend ticks nothing by itself — the window asks it to run what is
 * due — so a scheduled task needs the bridge and a logged-in tab, and the
 * page says so: a task that cannot run is worse than a task that was never
 * set.
 */
export async function renderScheduleTab(page, sheet) {
  const { el, rpc, state, addCommandOut, friendly } = sheet;

  page.append(el('p', 'settings-empty',
    'งานที่ตั้งเวลาไว้ต้องมี bridge และแท็บ de.aipass.net ที่ล็อกอินอยู่ — ถ้าปิดแอปหรือปิดแท็บไป งานก็จะไม่ทำงาน'));

  const list = el('div', 'set-group');
  const note = el('div', 'install-out dim', '');
  page.append(list);

  const paint = async () => {
    const res = await rpc('schedule.list').catch((err) => ({ error: err.message }));
    // An unreachable list is not an empty one: "no tasks" would read as if the
    // person never set any, when the bridge simply did not answer.
    if (res?.error) {
      list.textContent = '';
      list.append(el('p', 'install-out err', `อ่านตารางเวลาไม่ได้: ${friendly(res.error)}`));
      return;
    }
    const entries = res?.entries ?? [];
    state.schedule = entries;
    list.textContent = '';
    if (!entries.length) list.append(el('p', 'settings-empty', 'ยังไม่มีงานที่ตั้งเวลาไว้'));
    for (const e of entries) {
      const row = el('div', 'set-row');
      const info = el('div', 'set-info');
      info.append(el('div', 'set-title', e.task ?? '(ไม่มีงาน)'));
      info.append(el('div', 'set-note',
        `${e.at ?? '?'} · ${e.kind === 'once' ? 'ครั้งเดียว' : 'ทุกวัน'} · ${folderName(e.root)}${e.enabled === false ? ' · ปิดอยู่' : ''}`));
      const control = el('div', 'set-control');
      const del = el('button', 'danger-btn', 'ลบ');
      del.setAttribute('aria-label', `ลบงาน: ${e.task ?? e.id ?? ''}`);
      del.onclick = async () => {
        del.disabled = true;
        const done = await rpc('schedule.remove', { id: e.id }).catch((err) => ({ error: err.message }));
        del.disabled = false;
        if (done.error) { note.className = 'install-out err'; note.textContent = `ลบไม่สำเร็จ: ${friendly(done.error)}`; return; }
        note.className = 'install-out dim';
        note.textContent = '';
        addCommandOut('ลบงานที่ตั้งเวลาแล้ว');
        await paint();
      };
      control.append(del);
      row.append(info, control);
      list.append(row);
    }
  };
  await paint();

  const task = document.createElement('input');
  task.type = 'text';
  task.placeholder = 'งานที่จะให้ทำ — เช่น สรุปสิ่งที่ค้างในโปรเจกต์';
  task.setAttribute('aria-label', 'งานที่จะตั้งเวลา');
  const at = document.createElement('input');
  at.type = 'text';
  at.placeholder = 'เวลาของเครื่อง HH:MM — เช่น 09:00';
  at.setAttribute('aria-label', 'เวลาที่จะรัน (HH:MM)');
  const kind = document.createElement('select');
  kind.setAttribute('aria-label', 'ความถี่ของงาน');
  kind.append(optionEl('daily', 'ทุกวัน'));
  kind.append(optionEl('once', 'ครั้งเดียว'));
  kind.value = 'daily';

  const form = el('div', 'set-group');
  form.append(sheet.row('งาน', 'คำสั่งที่จะให้ agent ทำในโปรเจกต์นี้', task));
  form.append(sheet.row('เวลา', 'เวลาของเครื่องในรูปแบบ HH:MM', at));
  form.append(sheet.row('ซ้ำ', 'ทุกวัน หรือครั้งเดียวแล้วจบ', kind));

  const add = el('button', 'primary', 'เพิ่มงาน');
  add.onclick = async () => {
    add.disabled = true;
    const done = await rpc('schedule.add', {
      task: task.value.trim(),
      at: at.value.trim(),
      kind: kind.value,
      project: state.root ?? undefined,
    }).catch((err) => ({ error: err.message }));
    add.disabled = false;
    if (done.error) { note.className = 'install-out err'; note.textContent = `เพิ่มไม่สำเร็จ: ${friendly(done.error)}`; return; }
    note.className = 'install-out dim';
    note.textContent = '';
    task.value = '';
    at.value = '';
    addCommandOut(`ตั้งเวลาแล้ว: ${done.at ?? ''} · ${done.task ?? ''}`);
    await paint();
  };

  const due = el('button', null, 'รันที่ครบเวลาแล้ว');
  due.onclick = async () => {
    due.disabled = true;
    const out = await rpc('schedule.runDue').catch((err) => ({ error: err.message }));
    due.disabled = false;
    if (out.error) { note.className = 'install-out err'; note.textContent = `รันไม่สำเร็จ: ${friendly(out.error)}`; return; }
    note.className = 'install-out dim';
    note.textContent = out.count ? `เริ่ม ${out.count} งานที่ครบเวลาแล้ว` : 'ยังไม่มีงานที่ครบเวลา';
    await paint();
  };

  const actions = el('div', 'plugin-actions');
  actions.append(add, due);
  form.append(actions);
  page.append(form, note);
}
