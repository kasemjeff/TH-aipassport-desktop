/* The panel: the view of one run.
 *
 * Everything the panel knows arrives by message from the extension host — the
 * machine's state (status, credits, the staged changes) and the live frames
 * of the run. The panel opens no socket of its own: its own content security
 * policy says `connect-src 'none'`, because the loopback token lives in the
 * host and a webview is a page.
 *
 * The panel is a view and nothing else. The prose it shows has already been
 * through the marker stripper and the WAF restore table in the host, so what
 * lands here is what a reader should read.
 */
(() => {
  'use strict';

  const vscode = acquireVsCodeApi();

  const $ = (id) => document.getElementById(id);
  const log = $('log');

  /** What the panel is showing right now. */
  const state = {
    project: '',
    running: false,
    stopping: false,
    // True between sending a task and the run's first frame: the status poll
    // can land in that gap, and it would put the button back to "send" over a
    // run that is about to start.
    starting: false,
    bubble: null,
    doneShown: false,
    pending: new Map(),
    known: new Set(),
    asks: [],
    askOpen: false,
    reasoning: '',
    // The last backend problem said out loud, so a poll that repeats it does
    // not repeat the line.
    lastProblem: '',
  };

  /* ------------------------------------------------------------------ helpers */

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  /** The transcript follows the reader only while the reader is at the bottom. */
  const atBottom = () => log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  const scrollDown = (force = false) => {
    if (force || atBottom()) log.scrollTop = log.scrollHeight;
  };

  /* --------------------------------------------------------------- the calls */

  let rpcId = 0;
  const waiting = new Map();

  /**
   * One call to the backend, through the host.
   *
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<any>}
   */
  function call(method, params = {}) {
    const id = ++rpcId;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      vscode.postMessage({ kind: 'rpc', id, method, params });
    });
  }

  /* ------------------------------------------------------------- the drawing */

  const addTask = (text) => {
    const box = el('div', 'msg task');
    box.append(el('span', null, String(text ?? '')));
    log.append(box);
    scrollDown();
  };

  const addNote = (text, bad = false) => {
    log.append(el('div', bad ? 'note bad' : 'note', String(text ?? '')));
    scrollDown();
  };

  const addCmdOut = (text) => {
    log.append(el('div', 'cmd-out', String(text ?? '')));
    scrollDown();
  };

  /**
   * The bubble the reply's prose goes into.
   *
   * @returns {HTMLElement}
   */
  const ensureBubble = () => {
    if (state.bubble) return state.bubble;
    const box = el('div', 'msg assistant');
    const body = el('div', 'body');
    box.append(body);
    log.append(box);
    state.bubble = box;
    return box;
  };

  /** Close the bubble: the next prose starts a new one. */
  const closeBubble = () => { state.bubble = null; };

  /**
   * The reply's prose, as the host sent it.
   *
   * The host sends the whole clean text every time, not a delta: the markers
   * are line-shaped, so a delta cannot be cleaned on its own.
   *
   * @param {string} text
   */
  const setProse = (text) => {
    const box = ensureBubble();
    const body = box.querySelector('.body');
    if (body.textContent === text) return;
    body.textContent = text;
    scrollDown();
  };

  /** The label a reader would use for a call; the raw kind stays in the title. */
  const TOOL_LABEL = {
    read: 'อ่าน', list: 'ดูโฟลเดอร์', search: 'ค้นหา', glob: 'glob', run: 'รัน',
    replace: 'แก้ไข', write: 'สร้าง', delete: 'ลบ', move: 'ย้าย',
    git: 'git', fetch: 'ดึง', web: 'เว็บ', skill: 'คู่มือ', attach: 'แนบ',
    plan: 'แผน', todo: 'เช็คลิสต์', subagent: 'ผู้ช่วย', plugin: 'ปลั๊กอิน',
    symbols: 'สัญลักษณ์', def: 'นิยาม', refs: 'การอ้างอิง', jobs: 'งาน',
  };

  /**
   * One tool call, as a row.
   *
   * @param {object} data
   */
  const addTool = (data) => {
    const kind = String(data?.kind ?? '');
    const row = document.createElement('details');
    row.className = data?.ok === false ? 'tool bad' : 'tool';
    row.title = kind;
    const summary = document.createElement('summary');
    summary.append(el('span', 'mark', data?.ok === false ? '✗' : '⏺'));
    summary.append(el('span', 'kind', TOOL_LABEL[kind] ?? kind));
    if (data?.arg) summary.append(el('span', 'arg', String(data.arg)));
    if (data?.head) summary.append(el('span', 'head', String(data.head)));
    row.append(summary);
    const lines = Array.isArray(data?.lines) ? data.lines : [];
    if (lines.length) row.append(el('pre', null, lines.map((l) => String(l)).join('\n')));
    log.append(row);
    scrollDown();
  };

  /* ------------------------------------------------------------- the pending */

  /**
   * The staged changes.
   *
   * A file the human unticked stays unticked: the list is rebuilt on every
   * diff frame and again when the run ends, and a reset to "checked" would
   * re-select exactly the files they said no to (desktop/AGENTS.md, the same
   * rule).
   *
   * @param {Array} changes
   */
  const renderPending = (changes) => {
    const before = new Map(state.pending);
    state.pending.clear();
    for (const change of changes ?? []) {
      if (!change || !change.file) continue;
      state.pending.set(change.file, { ...change, checked: before.get(change.file)?.checked ?? true });
    }
    const list = $('pending-list');
    list.textContent = '';
    for (const [file, info] of state.pending) {
      const row = el('li');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = info.checked;
      box.setAttribute('aria-label', `เขียนไฟล์ ${file}`);
      box.onchange = () => { info.checked = box.checked; };
      row.append(box);
      row.append(el('span', 'name', file + (info.isNew ? ' (ไฟล์ใหม่)' : info.deleted ? ' (ถูกลบ)' : '')));
      row.append(el('span', 'add', `+${info.added ?? 0} `));
      row.append(el('span', 'del', `−${info.removed ?? 0}`));
      const view = el('button', 'mini', 'diff');
      view.setAttribute('aria-label', `ดู diff ของ ${file}`);
      view.onclick = () => { void showDiff(file); };
      row.append(view);
      list.append(row);
    }
    $('pending-count').textContent = `${state.pending.size} การเปลี่ยนแปลง`;
    $('pending').classList.toggle('hidden', state.pending.size === 0);
  };

  /**
   * One file's diff.
   *
   * @param {string} file
   */
  async function showDiff(file) {
    try {
      const change = await call('diff', { file });
      openSheet('สิทธิ์การเปลี่ยนแปลง', (body) => {
        body.append(el('p', 'dim', `${file}  +${change.added ?? 0} −${change.removed ?? 0}${change.isNew ? '  (ไฟล์ใหม่)' : ''}`));
        const pre = el('pre');
        for (const line of String(change.diff ?? '').split('\n')) {
          const cls = line.startsWith('+') && !line.startsWith('+++') ? 'diff-line add'
            : line.startsWith('-') && !line.startsWith('---') ? 'diff-line del'
              : line.startsWith('@@') ? 'diff-line hunk' : 'diff-line';
          pre.append(el('div', cls, line));
        }
        body.append(pre);
      }, [{ label: 'ปิด', run: closeSheet }]);
    } catch (err) {
      addNote(`ดู diff ไม่ได้: ${err?.message ?? err}`, true);
    }
  }

  /* ----------------------------------------------------------------- the asks */

  /**
   * The sheet: a dialog that asks, and the answers go back to the run.
   *
   * @param {string} title
   * @param {(body: HTMLElement) => void} fill
   * @param {Array<{label: string, run: () => void, primary?: boolean}>} actions
   */
  function openSheet(title, fill, actions) {
    $('ask-title').textContent = title;
    const body = $('ask-body');
    body.textContent = '';
    fill(body);
    const holder = $('ask-actions');
    holder.textContent = '';
    for (const action of actions) {
      const button = el('button', action.primary ? 'primary' : null, action.label);
      button.onclick = action.run;
      holder.append(button);
    }
    $('ask').classList.remove('hidden');
    const first = holder.querySelector('button');
    if (first) first.focus();
  }

  const closeSheet = () => {
    $('ask').classList.add('hidden');
    state.askOpen = false;
    showNextAsk();
  };

  /**
   * The permission question, answered the way the window answers it.
   *
   * @param {object} data
   */
  const askPermission = (data) => {
    const plugin = data?.kind === 'plugin';
    const exfil = data?.risk === 'exfil';
    const title = plugin ? 'ให้รัน marker ของปลั๊กอินนี้ไหม'
      : exfil ? 'ให้ส่งข้อมูลนี้ออกจากเครื่องไหม'
        : data?.risk === 'shell' ? 'ให้รันคำสั่งนี้ไหม'
          : 'ให้แก้ไขไฟล์นี้ไหม';
    openSheet(title, (body) => {
      if (plugin) body.append(el('p', 'dim', 'ปลั๊กอินที่โมเดลอยากเรียก'));
      body.append(el('pre', null, String(data?.arg ?? data?.kind ?? '')));
      if (data?.preview) body.append(el('pre', null, String(data.preview)));
      if (data?.project) body.append(el('p', 'dim', `จากโปรเจกต์อื่น (${data.project}) — คำตอบนี้จะไปถึง run ของโปรเจกต์นั้น`));
    }, [
      { label: 'ไม่อนุญาต', run: () => answerPermission(data, 'deny') },
      { label: 'อนุญาตเสมอ', run: () => answerPermission(data, 'always') },
      { label: 'อนุญาต', run: () => answerPermission(data, 'allow'), primary: true },
    ]);
  };

  /**
   * The answer goes back to the run that asked — the project is named, so a
   * question about another project is not answered blind.
   *
   * @param {object} data
   * @param {string} decision
   */
  const answerPermission = (data, decision) => {
    const params = { id: data?.id, decision };
    if (data?.project) params.project = data.project;
    void call('permission.answer', params).catch((err) => addNote(`ตอบไม่ได้: ${err?.message ?? err}`, true));
    closeSheet();
  };

  /**
   * The plan question.
   *
   * @param {object} data
   */
  const askPlan = (data) => {
    openSheet('เริ่มตามแผนนี้ไหม', (body) => {
      body.append(el('p', null, 'โมเดลเขียนแผนไว้ — อนุมัติแล้วงานจึงเริ่ม ถ้าไม่อนุมัติ รันจะหยุดก่อนแตะไฟล์ใดๆ'));
      if (data?.project) body.append(el('p', 'dim', `จากโปรเจกต์อื่น (${data.project})`));
    }, [
      { label: 'ไม่อนุมัติ', run: () => answerPlan(data, false) },
      { label: 'อนุมัติ', run: () => answerPlan(data, true), primary: true },
    ]);
  };

  /**
   * @param {object} data
   * @param {boolean} ok
   */
  const answerPlan = (data, ok) => {
    const params = { ok };
    if (data?.project) params.project = data.project;
    void call('plan.answer', params).catch((err) => addNote(`ตอบไม่ได้: ${err?.message ?? err}`, true));
    closeSheet();
  };

  /** Show the next question, one at a time — the window's rule. */
  const showNextAsk = () => {
    if (state.askOpen) return;
    const next = state.asks.shift();
    if (!next) return;
    state.askOpen = true;
    if (next.kind === 'plan') askPlan(next.data);
    else askPermission(next.data);
    if (state.asks.length) addNote(`มีคำถามรออนุมัติอีก ${state.asks.length} รายการ — ตอบข้อนี้ก่อน`);
  };

  /* ---------------------------------------------------------------- the state */

  /**
   * The machine's picture: the header, the staged changes, the meter.
   *
   * @param {object} picture
   */
  const applyState = (picture) => {
    if (picture.project) {
      state.project = picture.project;
      $('project').textContent = picture.project.split(/[\\/]/).filter(Boolean).pop() ?? picture.project;
      $('project').title = picture.project;
    }
    if (Array.isArray(picture.events)) {
      state.known = new Set(picture.events);
    }
    const status = picture.status;
    if (status) {
      $('model').textContent = [status.model ?? '-', status.provider && status.provider !== 'aipass' ? status.provider : '']
        .filter(Boolean).join(' · ');
      $('model').title = `โปรเจกต์: ${status.root ?? '-'}`;
      // The backend's word about the run wins — except while this panel is
      // starting one: the status call can land between the send and the
      // first frame, and it would put the button back to "send" over a run
      // that is about to start.
      if (typeof status.running === 'boolean' && !state.starting && status.running !== state.running) {
        setRunning(status.running);
      }
    }
    if ('credits' in picture) {
      const available = picture.credits?.available;
      const limit = picture.credits?.limit;
      $('credits').textContent = available == null ? 'เครดิต: —' : `เครดิต ${available} / ${limit ?? '?'}`;
      $('credits').title = picture.credits?.used == null ? '' : `ใช้ไป ${picture.credits.used}`;
    }
    if (Array.isArray(picture.pending)) renderPending(picture.pending);
    if (picture.snapshot) restore(picture.snapshot);
    if (picture.error) showBackendProblem(picture.error);
  };

  /**
   * The conversation the backend kept: a panel that was closed and opened
   * again comes back with what it left, not with an empty stage.
   *
   * @param {object} snapshot
   */
  const restore = (snapshot) => {
    const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : [];
    for (const entry of entries) {
      if (entry?.type === 'task') addTask(entry.text);
      else if (entry?.type === 'assistant') {
        ensureBubble().querySelector('.body').textContent = String(entry.text ?? '');
        closeBubble();
      } else if (entry?.type === 'note') addNote(entry.text);
    }
    const asks = snapshot?.asks ?? {};
    if (Array.isArray(asks.permissions) && asks.permissions.length) {
      state.asks.push(...asks.permissions.map((data) => ({ kind: 'permission', data })));
    }
    if (asks.plan) state.asks.push({ kind: 'plan', data: { project: snapshot?.status?.root } });
    if (snapshot?.status?.running) setRunning(true);
    showNextAsk();
  };

  /**
   * The backend is not answering — say so, and say how to start it.
   *
   * The note is said once per problem: the panel asks the backend every ten
   * seconds, and a line that came back with every poll would be noise (the
   * window shows a banner for the same reason).
   *
   * @param {{kind: string, message: string}} problem
   */
  const showBackendProblem = (problem) => {
    const chip = $('backend');
    chip.classList.add('bad');
    const said = state.lastProblem;
    state.lastProblem = `${problem.kind}:${problem.message ?? ''}`;
    if (said === state.lastProblem) return;
    if (problem.kind === 'offline') {
      chip.textContent = 'backend ไม่ทำงาน';
      addNote('backend ไม่ทำงาน — เปิดด้วยคำสั่ง `aipass desktop` (หรือ `npm run desktop`) แล้วกดรีเฟรช', true);
      return;
    }
    if (problem.kind === 'unauthorized') {
      chip.textContent = 'token ไม่ผ่าน';
      addNote('backend ปฏิเสธ token — ปิดแล้วเปิด aipass ใหม่ (backend กับ extension ต้องอ่านไฟล์ token เดียวกัน)', true);
      return;
    }
    chip.textContent = 'backend ตอบไม่ได้';
    addNote(`backend ตอบไม่ได้: ${problem.message}`, true);
  };

  /**
   * The run's state: the send button becomes the stop, and the hint says what
   * is happening.
   *
   * @param {boolean} on
   * @param {string} [label]
   */
  const setRunning = (on, label = '') => {
    state.running = on;
    if (!on) {
      state.stopping = false;
      $('send').textContent = 'ส่ง';
      $('hint').textContent = '';
      $('hint').classList.remove('busy');
      log.setAttribute('aria-busy', 'false');
      return;
    }
    $('send').textContent = 'หยุด';
    $('hint').textContent = label || 'กำลังทำงาน…';
    $('hint').classList.add('busy');
    log.setAttribute('aria-busy', 'true');
  };

  /* --------------------------------------------------------------- the events */

  /** How a run's ending reads, in the language of the reader. */
  const STOP_REASON = {
    cancelled: 'หยุดแล้ว',
    'plan-rejected': 'แผนไม่ผ่าน — หยุดก่อนแก้อะไร',
    error: 'รันพัง',
    stalled: 'ค้าง — หยุด',
    stagnation: 'ค้าง — หยุด',
    'credit-limited': 'โควตตาเกิด — หยุด',
    'tools-limited': 'เครื่องมือครบโควตา — หยุด',
    'time-limited': 'หมดเวลา — หยุด',
    steps: 'ครบจำนวนรอบ',
    'done-unverified': 'เสร็จแต่ยังไม่ผ่านการตรวจ',
    ask: 'รอคำตอบจากคุณ',
  };

  /**
   * One frame of the run.
   *
   * @param {string} name
   * @param {any} data
   */
  const onEvent = (name, data) => {
    const d = data ?? {};
    switch (name) {
      case 'task_start':
        state.doneShown = false;
        state.starting = false;
        setRunning(true);
        addTask(d.task);
        break;
      case 'step':
        closeBubble();
        state.reasoning = '';
        addNote(d.maxSteps > 0 ? `step ${d.step}/${d.maxSteps} · ${d.elapsed}s` : `step ${d.step} · ${d.elapsed}s`);
        break;
      case 'reasoning_delta':
        state.reasoning += String(d.text ?? '');
        renderReasoning();
        break;
      case 'thinking':
        log.append(el('div', 'thinking', `⎿ ${d.text ?? ''}`));
        scrollDown();
        break;
      case 'tool':
        addTool(d);
        break;
      case 'note':
      case 'firewall_note':
        addNote(d.text ?? '');
        break;
      case 'nudge':
        addNote(`ไม่มี marker ในคำตอบนั้น — ส่งอีกครั้ง (${d.n}/2)`);
        break;
      case 'give_up':
        addNote('ไม่มี marker หลังสามคำตอบ — หยุดแล้ว');
        break;
      case 'ignore_done':
        addNote('(ข้าม DONE — มันมาก่อนผลที่มันขอ)');
        break;
      case 'stagnation':
        addNote(d.action === 'stop' ? 'ลูปไม่เดินหน้า — หยุดให้แล้ว' : 'ลูปไม่เดินหน้า — สั่งให้เปลี่ยนวิธีแล้ว');
        break;
      case 'verify_prompt':
        addNote('ขอให้โมเดลพิสูจน์สิ่งที่แก้ก่อนจบ — รันเช็ค หรืออ่านการแก้กลับมา');
        break;
      case 'check_start':
        addNote(`ก่อนรับ DONE — ให้ตรวจงานที่ค้างอยู่ (${(d.files ?? []).length} ไฟล์)`);
        break;
      case 'check_end':
        addNote(d.skipped ? 'ข้ามการตรวจ — เปิดบทสนทนาแยกไม่สำเร็จ'
          : d.verdict === 'pass' ? `ตรวจผ่านแล้ว (${d.ran} command)`
            : d.verdict === 'fail' ? `ตรวจไม่ผ่าน (${d.ran} command) — ส่งผลให้โมเดลแก้ต่อ`
              : 'ตรวจแล้ว ไม่มีคำสั่งให้รัน');
        break;
      case 'budget':
        addNote(`ใช้ budget ครบ (${d.used}) — หยุด`);
        break;
      case 'step_limit':
        addNote('ครบจำนวนรอบแล้ว');
        break;
      case 'error':
        addNote(`error: ${d.message ?? ''}`, true);
        break;
      case 'todo':
        renderTodo(d.items);
        break;
      case 'diff_update':
        renderPending(d.changes);
        break;
      case 'permission_request':
        state.asks.push({ kind: 'permission', data: d });
        showNextAsk();
        break;
      case 'plan_request':
        state.asks.push({ kind: 'plan', data: d });
        showNextAsk();
        break;
      case 'compacted':
        addCmdOut('context เต็ม — สรุปงานที่ผ่านมาแล้วไว้ในบทสนทนาใหม่');
        if (d.summary) {
          const box = el('div', 'summary');
          box.append(el('div', null, 'สิ่งที่ยังจำอยู่หลังการหมุนบทสนทนา'));
          box.append(el('div', null, String(d.summary)));
          log.append(box);
        }
        break;
      case 'helper_start':
        addNote(`ผู้ช่วยเริ่ม: ${d.task ?? ''}`);
        break;
      case 'helper_end':
        addNote(`ผู้ช่วยเสร็จ: ${d.summary ?? ''}`);
        break;
      case 'plugin_call':
        addNote(`ปลั๊กอิน ${d.marker ?? ''} ${d.arg ?? ''}`.trim());
        break;
      case 'ask':
        addNote(d.text ?? '');
        break;
      case 'done_line': {
        // A DONE is said once: the summary is shown here, and the run's
        // ending never says it again.
        const text = String(d.text ?? 'เสร็จแล้ว');
        const box = el('div', 'summary');
        box.append(el('div', null, text));
        log.append(box);
        if (d.extra) log.append(el('div', 'note', String(d.extra)));
        state.doneShown = true;
        closeBubble();
        scrollDown();
        break;
      }
      case 'cancelled':
        if (d.running === false) { addNote('ไม่มีรันที่กำลังทำอยู่'); break; }
        state.stopping = true;
        $('send').textContent = 'กำลังหยุด…';
        $('hint').textContent = 'กำลังหยุด…';
        addNote('รับคำสั่งหยุดแล้ว — กำลังจบงานที่กำลังทำอยู่');
        break;
      case 'finished': {
        // The summary is only said here when no DONE line said it already.
        if (!state.doneShown && d.summary) {
          const box = el('div', 'summary');
          box.append(el('div', null, String(d.summary)));
          log.append(box);
        }
        state.doneShown = false;
        state.starting = false;
        setRunning(false);
        if (d.credits && d.credits.available != null) {
          addNote(`เครดิตเหลือ ${d.credits.available} จาก ${d.credits.limit ?? '?'}${d.spent > 0 ? ` · ใช้ไป ${d.spent} ในรันนี้` : ''}`);
        }
        if (d.stopReason && d.stopReason !== 'done') addNote(STOP_REASON[d.stopReason] ?? `หยุด: ${d.stopReason}`);
        if (Array.isArray(d.todo) && d.todo.length) renderTodo(d.todo);
        if (Array.isArray(d.changes)) renderPending(d.changes);
        closeBubble();
        break;
      }
      case 'applied':
        addNote(`เขียนแล้ว ${d.written ?? 0} ไฟล์${d.deleted ? ` · ลบ ${d.deleted}` : ''}${Array.isArray(d.files) && d.files.length ? ` — ${d.files.join(', ')}` : ''}`);
        renderPending([]);
        break;
      case 'discarded':
        renderPending([]);
        addNote('ทิ้งการเปลี่ยนแปลงแล้ว');
        break;
      case 'needs_tab': {
        // The one failure with a one-click fix: the backend says which tab
        // it needs, and the panel opens it.
        const url = String(d.url ?? '');
        const row = el('div', 'note');
        row.append(el('span', null, 'bridge ต้องมีหน้า chat ที่ล็อกอินอยู่ — '));
        const open = el('button', 'mini', 'เปิดให้');
        open.onclick = () => { void call('browser.open', { url }).catch(() => {}); };
        row.append(open);
        if (url) row.append(el('span', 'dim', `  (${url})`));
        log.append(row);
        scrollDown();
        break;
      }
      case 'tab_opened':
        addNote(`เปิด ${d.url ?? ''} ในบราวเซอร์แล้ว — รอสักครู่แล้วส่งใหม่`);
        break;
      case 'session':
        break;
      default:
        // A frame this panel does not know is still shown: a new event from
        // the backend must not disappear silently.
        if (!state.known.has(name)) addNote(`เหตุการณ์ใหม่จาก backend: ${name}`);
        break;
    }
  };

  /**
   * The reasoning, folded.
   *
   * The model's thinking arrives as a stream of its own. It is not the
   * answer, so it does not go into the bubble — it goes into a row the
   * reader can open, the way the window folds it.
   */
  const renderReasoning = () => {
    let fold = document.getElementById('reasoning-fold');
    if (!fold) {
      fold = el('details', 'thinking');
      fold.id = 'reasoning-fold';
      const summary = document.createElement('summary');
      summary.textContent = 'ความคิดของโมเดล';
      const body = el('pre');
      fold.append(summary, body);
      log.append(fold);
      fold.__body = body;
    }
    fold.__body.textContent = state.reasoning;
  };

  /**
   * The checklist card.
   *
   * @param {Array} items
   */
  const renderTodo = (items) => {
    if (!Array.isArray(items)) return;
    let card = document.getElementById('todo-card');
    if (!card) {
      card = el('div', 'summary');
      card.id = 'todo-card';
      const head = el('div');
      const list = el('ul');
      card.append(head, list);
      log.append(card);
      card.__head = head;
      card.__list = list;
    }
    const done = items.filter((it) => it?.done).length;
    card.__head.textContent = `แผน & เช็คลิสต์ · ${done}/${items.length}`;
    card.__list.textContent = '';
    for (const item of items) {
      const li = el('li', item?.done ? 'dim' : null);
      li.textContent = `${item?.done ? '☑' : '☐'} ${item?.text ?? ''}`;
      card.__list.append(li);
    }
    scrollDown();
  };

  /* ------------------------------------------------------------- the composer */

  const saved = vscode.getState();
  if (saved && typeof saved.draft === 'string') $('task').value = saved.draft;
  $('task').addEventListener('input', () => {
    vscode.setState({ draft: $('task').value });
  });

  /**
   * Send a task.
   *
   * @param {string} [text]
   */
  const sendTask = async (text) => {
    const body = String(text ?? $('task').value).trim();
    if (!body) return;
    if (state.running) return;
    $('task').value = '';
    vscode.setState({ draft: '' });
    state.starting = true;
    setRunning(true);
    try {
      await call('run', { task: body, root: state.project || undefined, title: body.slice(0, 60) });
    } catch (err) {
      state.starting = false;
      addNote(`ส่งงานไม่ได้: ${err?.message ?? err}`, true);
      setRunning(false);
    }
  };

  /**
   * Stop the run.
   *
   * The backend answers what it stopped: `running: false` means there was
   * nothing to stop, and the panel says so instead of pretending.
   */
  const cancelRun = async () => {
    if (state.stopping) return;
    state.stopping = true;
    $('send').textContent = 'กำลังหยุด…';
    try {
      const res = await call('cancel', { root: state.project });
      if (res && res.ok === false) {
        state.stopping = false;
        setRunning(false);
        addNote(`หยุดไม่ได้ — ไม่มีรันที่กำลังทำอยู่${res.reason ? ` (${res.reason})` : ''}`);
      }
    } catch (err) {
      state.stopping = false;
      setRunning(false);
      addNote(`หยุดไม่ได้: ${err?.message ?? err}`, true);
    }
  };

  $('composer').onsubmit = (ev) => {
    ev.preventDefault();
    void sendTask();
  };

  $('send').onclick = (ev) => {
    ev.preventDefault();
    if (state.running) void cancelRun();
    else void sendTask();
  };

  $('task').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      void sendTask();
    }
  });

  $('apply').onclick = async () => {
    const files = [...state.pending.entries()].filter(([, info]) => info.checked).map(([file]) => file);
    if (!files.length) { addNote('ยังไม่ได้ติ๊กไฟล์ให้เขียน'); return; }
    try {
      await call('apply', { files });
      addNote(`เขียน ${files.length} ไฟล์แล้ว`);
      renderPending([]);
    } catch (err) {
      addNote(`เขียนไฟล์ไม่ได้: ${err?.message ?? err}`, true);
    }
  };

  $('discard').onclick = async () => {
    try {
      await call('discard');
      renderPending([]);
      addNote('ทิ้งการเปลี่ยนแปลงแล้ว');
    } catch (err) {
      addNote(`ทิ้งไม่ได้: ${err?.message ?? err}`, true);
    }
  };

  /* ------------------------------------------------------------------ the wire */

  window.addEventListener('message', (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg.kind !== 'string') return;
    switch (msg.kind) {
      case 'ready':
        vscode.postMessage({ kind: 'ready' });
        break;
      case 'state':
        applyState(msg);
        break;
      case 'backend':
        if (msg.online) {
          $('backend').classList.remove('bad');
          $('backend').textContent = `backend พร้อม · ${msg.port}`;
        } else if (msg.reason === 'unauthorized') {
          showBackendProblem({ kind: 'unauthorized', message: '' });
        } else if (msg.reason === 'closed' || msg.reason === 'error') {
          $('backend').classList.add('bad');
          $('backend').textContent = 'backend หลุด';
        }
        break;
      case 'prose':
        setProse(String(msg.text ?? ''));
        break;
      case 'event':
        onEvent(msg.name, msg.data);
        break;
      case 'rpc-result': {
        const call_ = waiting.get(msg.id);
        if (!call_) return;
        waiting.delete(msg.id);
        if (msg.ok) call_.resolve(msg.result);
        else {
          const error = new Error(msg.error ?? 'เรียกไม่สำเร็จ');
          error.kind = msg.errorKind ?? 'unknown';
          call_.reject(error);
        }
        break;
      }
      case 'focus':
        $('task').focus();
        break;
      default:
        break;
    }
  });

  vscode.postMessage({ kind: 'ready' });
})();
