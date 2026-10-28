// The banners: the notices the window pins over its conversation.
//
// A failure with a one-click fix gets a banner, not a log line (the no-chat-tab
// strip is the shape), and so does a state the reader has to know: the
// extension's missing token, the model catalog's fallback, a new release. One
// banner per subject, not one per poll — the header asks the backend every ten
// seconds, and a banner that came and went with every poll would be noise.
//
// The welcome card lives here too: it is the window's "nothing to show yet",
// and a banner takes one thing off its readiness list, not the whole of it.


/**
 * The banners, the welcome card and the update notice.
 *
 * @param {object} ctx the window it draws into
 */
export function createBanners(ctx) {
  const { $, el, log, state, rpc, client, scrollDown, setHint, setWorking, addNote, addCommandOut, refreshModels } = ctx;

  /* The extension's token --------------------------------------------------
   *
   * The extension talks to the bridge, not to the window, and the bridge
   * refuses it without the loopback token. That refusal reaches the reader as
   * "extensions: 0" — the same number a missing extension gives — so the fix
   * was a hunt through the home directory for a file of hex, pasted by hand
   * into a popup in another window.
   *
   * The bridge now says which state it is (/status), and the window does the
   * half it can: it already holds the token (it fetched it from /token when it
   * booted), so one click puts it on the clipboard and the step that only the
   * popup can do is a paste. The token is never read from disk here and never
   * minted here.
   */
  let extensionTokenBar = null;

  /** The token this window already holds — the one the backend minted. */
  async function ownToken() {
    return client.ensureToken();
  }

  /** Put the loopback token on the clipboard, so the popup's paste finds it. */
  async function putTokenOnClipboard() {
    const token = await ownToken();
    if (!token) {
      addNote('อ่าน token ไม่ได้ — ดูไฟล์ ~/.aipass/.token แล้ววางเอง');
      return false;
    }
    try {
      await navigator.clipboard.writeText(token);
      return true;
    } catch {
      addNote('เขียนคลิปบอร์ดไม่ได้ — คัดลอกจาก ~/.aipass/.token เอง');
      return false;
    }
  }

  /** The button that does the half the window can do. */
  function tokenFixButton() {
    const btn = el('button', 'mini', 'วาง token ให้');
    btn.onclick = async () => {
      btn.disabled = true;
      const ok = await putTokenOnClipboard();
      btn.disabled = false;
      if (!ok) return;
      btn.remove();
      addNote('วาง token ลงคลิปบอร์ดแล้ว — เปิด popup ของ extension → Advanced → "Paste from clipboard" → Save');
    };
    return btn;
  }

  /**
   * Show the extension's missing token, and take it down when it is fixed.
   *
   * One banner, not one per poll: the header asks the backend every ten
   * seconds, and a banner that came and went with every poll would be noise.
   */
  function syncExtensionToken() {
    const missing = state.extensionToken === 'missing';
    if (!missing) {
      extensionTokenBar?.remove();
      extensionTokenBar = null;
      return;
    }
    if (extensionTokenBar) return;
    const bar = el('div', 'note needs-tab');
    bar.append(el('span', null, 'extension ยังไม่ได้รับ token — '));
    bar.append(tokenFixButton());
    bar.append(el('span', null, '  (เปิด popup ของ extension → Advanced → "Paste from clipboard" → Save)'));
    log.append(bar);
    extensionTokenBar = bar;
    scrollDown();
  }

  /* The model catalog's banner --------------------------------------------- */

  let catalogBar = null;

  /**
   * Say that the list on screen is not the site's list, and offer the fix.
   *
   * One banner, not one per poll: the header asks the backend every ten
   * seconds, and a banner that came and went with every poll would be noise.
   */
  function syncCatalogBanner() {
    // The catalog is the window's own state and is built after the modules
    // are, so it reaches the banners through the context rather than the
    // factory's destructuring.
    const { error, source } = ctx.modelState ?? {};
    const broken = Boolean(error);
    const stub = source === 'fallback' || source === 'none';
    if (!broken && !stub) {
      catalogBar?.remove();
      catalogBar = null;
      return;
    }
    const text = broken
      ? `ดึงรายชื่อโมเดลไม่สำเร็จ: ${error}`
      : (source === 'none'
        ? 'ผู้ให้บริการไม่ได้ตอบรายชื่อโมเดล'
        : 'รายชื่อโมเดลยังเป็นรายการสำรอง — ต้องมีหน้า de.aipass.net ที่ล็อกอินอยู่ และ extension ต้องต่ออยู่');
    if (catalogBar) {
      // The bar is already up and the reason may have changed: the text is
      // rewritten in place rather than a second bar appearing.
      catalogBar.textContent = '';
    } else {
      catalogBar = el('div', 'note needs-tab');
      log.append(catalogBar);
      scrollDown();
    }
    catalogBar.append(el('span', null, `${text} — `));
    const again = el('button', 'mini', 'รีเฟรช');
    again.onclick = () => { void refreshModels(); };
    catalogBar.append(again);
  }

  /* The welcome card --------------------------------------------------------- */

  /**
   * What the window says when there is nothing to show yet.
   *
   * An empty main area reads as "broken" — the first thing on screen has to say
   * what this is, whether it can run right now, and what to type. It disappears
   * the moment a task starts, and comes back when a session is empty again.
   */
  /**
   * Does the transcript hold a conversation?
   *
   * The welcome card is the window's "nothing here yet" note, so it does not
   * count as one: a window that shows the card must not hide it behind a
   * conversation, and a window that HAS a conversation must not have the card
   * pushed in underneath it.
   *
   * A banner is not a conversation either — it is the window's notice ("there
   * is no chat tab", "the update is ready"), and the card still belongs under
   * it. The card lists what the app is waiting for, and a banner takes one
   * thing away from that list, not the whole of it.
   *
   * The card is held by a reference and not looked up by id: it is built at
   * runtime, and an element that is not in the document cannot be found by
   * getElementById.
   */
  let welcomeCard = null;
  // The update bar and the version it named: the six-hour poll must not stack
  // the same notice, and a transcript reset drops it with the log.
  let updateBar = null;
  let shownUpdateKey = '';
  const isBanner = (n) => /\b(needs-tab|update-bar)\b/.test(n.className ?? '');
  // The rows are copied out of the collection first: in the browser `children`
  // is an HTMLCollection, which has a length but no `some`.
  const hasConversation = () => [...log.children].some((n) => n !== welcomeCard && !isBanner(n));

  function showWelcome(readiness) {
    // The card belongs to an empty window. It used to be painted whatever was
    // on screen, so a reloaded window came back to the welcome card with the
    // transcript pushed under it — and "the app forgot everything" is what that
    // looks like.
    if (hasConversation()) { hideWelcome(); return; }
    hideWelcome();
    const card = el('div', 'welcome');
    card.id = 'welcome';
    welcomeCard = card;

    card.append(el('h2', null, 'aipass desktop'));
    card.append(el('p', null, 'คุยกับโมเดลของ de.aipass.net จากหน้านี้ แล้วสั่งให้แก้ไฟล์ในโปรเจกต์ของคุณ'));

    const list = el('ul');
    const items = [
      ['คุย', 'พิมพ์คำถามแล้วกด Enter — ตอบสตรีมตรง ๆ ไม่ต้องเปิดบราวเซอร์'],
      ['สั่งแก้ไฟล์', 'บอกอย่าง "สรุป README ให้สั้นลง" มันอ่านแล้วแก้ให้ โดยอนุมัติทุกไฟล์ก่อนเขียน'],
      ['แนบไฟล์', 'ลากรุป เอกสาร หรือวิดีโอมาวางบนหน้านี้ แล้วถามเกี่ยวมันได้เลย'],
    ];
    for (const [head, body] of items) {
      const li = el('li');
      li.append(el('strong', null, head), el('span', null, ' — ' + body));
      list.append(li);
    }
    card.append(list);

    const ready = el('div', 'ready');
    const rows = readiness.provider
      // Another provider is reached by the backend itself: the bridge, the
      // extension and the chat tab are not part of that path, so listing them
      // as "not ready" would name a problem that does not exist.
      ? [['provider', `ผู้ให้บริการ ${readiness.provider}`, readiness.providerOk !== false]]
      : [
        ['bridge', 'ตัวกลาง local', readiness.bridge],
        ['extension', 'ส่วนขยายใน Chrome', readiness.extensions > 0],
        ['tab', 'หน้า de.aipass.net ที่ล็อกอินอยู่', readiness.tab],
        // A fourth row only when the quota is known: 0 available reads as
        // "broken" without it, while null (no tab) means the tab row already
        // explains what to fix.
        ...(readiness.credits === null || readiness.credits === undefined ? [] : [[
          'credits',
          `เครดิต ${readiness.credits.available} / ${readiness.credits.limit}`,
          Number(readiness.credits.available) > 0,
        ]]),
      ];
    for (const [key, label, ok] of rows) {
      const row = el('div', 'ready-row ' + (ok ? 'ok' : 'no'));
      row.append(el('span', 'dot ' + (ok ? 'ok' : 'no')));
      row.append(el('span', null, `${ok ? 'พร้อม — ' : 'ยังไม่ได้ — '}${label}`));
      row.append(el('span', 'grow'));
      if (!ok && key === 'tab') {
        const fix = el('button', 'mini', 'เปิดให้');
        fix.onclick = () => rpc('browser.open', { url: appSettingsUrl() }).catch(() => {});
        row.append(fix);
      }
      if (!ok && key === 'credits') row.append(el('span', 'dim', 'รอรอบถัดไป หรือใช้โมเดล free-credit'));
      if (!ok && key === 'extension') {
        // Two jobs behind one red dot: the extension was never loaded, or the
        // bridge refused it for want of the loopback token. The bridge says
        // which — sending the reader to load an extension that is already
        // loaded is a dead end.
        if (readiness.extensionToken === 'missing') {
          row.append(el('span', 'dim', 'ยังไม่ได้รับ token — '), tokenFixButton());
        } else {
          row.append(el('span', 'dim', 'โหลดจากโฟลเดอร์ aipass-bridge/extension'));
        }
      }
      if (!ok && key === 'bridge') row.append(el('span', 'dim', 'รัน aipass dev'));
      ready.append(row);
    }
    card.append(ready);

    card.append(el('p', 'dim', 'เริ่มจากพิมพ์ข้อความข้างล่างได้เลย · กด ? เพื่อดูวิธีใช้ทั้งหมด'));
    log.append(card);
  }

  /**
   * Take the welcome card off the screen.
   *
   * The card is held by a reference: it is built at runtime, and an element
   * that is not in the document cannot be found by getElementById — so a card
   * this window built would not be found when it has to go.
   */
  function hideWelcome() {
    welcomeCard?.remove();
    welcomeCard = null;
    $('welcome')?.remove();
  }

  const appSettingsUrl = () => state.settings?.chatUrl ?? 'https://de.aipass.net/chat';

  async function refreshReadiness() {
    const st = await rpc('status').catch(() => null);
    if (!st) { showWelcome({ bridge: false, extensions: 0, tab: false }); return; }
    // A provider that is not AiPASS is reached by the backend itself, so the
    // bridge and the chat tab are not on its path.
    if (st.provider && st.provider !== 'aipass') {
      showWelcome({ provider: st.provider, providerOk: true });
      return;
    }
    // The quota is what tells "no tab" (null — the tab row names the fix) from
    // "tab attached but the pool is empty" (0 — the new credits row names its
    // own fix). Idle windows ride the bridge cache (force:false); a run spends,
    // so it forces.
    const credits = await rpc('credits', { force: Boolean(state.running) }).catch(() => null);
    showWelcome({
      bridge: st.bridge,
      extensions: st.extensions ?? 0,
      // The extension's own token: loaded and refused is not the same as not
      // loaded, and the bridge is the one that knows.
      extensionToken: st.extensionToken === 'missing' ? 'missing' : 'ok',
      // A run can only tell us "no tab" by failing, so the strip stays neutral
      // until that happens; the banner flips it and offers the fix.
      tab: !state.needsTab,
      credits: credits ?? null,
    });
  }

  /* The update notice --------------------------------------------------------- */

  /**
   * The update notice.
   *
   * One line and one button, the same shape as the "no chat tab" banner: a
   * failure with a one-click fix gets a banner, not a log line. It never
   * interrupts a run, and it never applies anything on its own — the click is
   * the consent, and the content version is on screen before and after.
   */
  function showUpdate(res) {
    const content = res?.available?.content;
    const shell = res?.available?.shell;
    if (!content && !shell) {
      const bar = el('div', 'note update-bar');
      bar.append(el('span', null, res?.reason ? `อัปเดต: ${res.reason}` : 'อัปเดต: เป็นเวอร์ชันล่าสุดแล้ว'));
      log.append(bar);
      scrollDown();
      return;
    }
    // The check runs every six hours: the same available version must not
    // stack a fresh bar each poll. A version is said once per window — the
    // "ไม่ตอนนี้" click is that version's dismissal — and a newer version
    // replaces the bar in place.
    const key = `${content?.version ?? ''}|${shell?.version ?? ''}`;
    if (key === shownUpdateKey) return;
    shownUpdateKey = key;
    if (updateBar?.isConnected) updateBar.remove();
    updateBar = el('div', 'note update-bar');
    const bar = updateBar;
    const version = content?.version ?? shell?.version;
    bar.append(el('span', null, `มีเวอร์ชันใหม่ ${version}`));
    if (content) {
      const install = el('button', 'mini', 'อัปเดตเดี๋ยวนี้');
      install.onclick = () => applyUpdate();
      bar.append(install);
    }
    if (shell) {
      // The binary is replaced by the installer, and the app has to be closed
      // for it — so this one says so, and the app closes itself.
      const reinstall = el('button', 'mini', 'ติดตั้งเวอร์ชันนี้ (แอปจะปิดแล้วเปิดใหม่)');
      reinstall.onclick = () => installShellUpdate();
      bar.append(reinstall);
    }
    if (content?.notes) bar.append(el('span', 'dim', `— ${content.notes}`));
    const later = el('button', 'mini', 'ไม่ตอนนี้');
    later.onclick = () => bar.remove();
    bar.append(later);
    log.append(bar);
    scrollDown();
  }

  /**
   * Ask what is out there.
   *
   * The check runs once at startup and then every six hours: the feed is a
   * static file, and a machine that is offline gets nothing rather than an
   * error. Nothing is nagged — the notice appears when there is genuinely
   * something new.
   */
  async function checkForUpdate({ force = false, quiet = true } = {}) {
    const res = await rpc('update.check', { force }).catch(() => null);
    if (!res) return null;
    if (res.available?.content || res.available?.shell) {
      showUpdate(res);
    } else if (!quiet) {
      addCommandOut(res.reason ? `อัปเดต: ${res.reason}` : 'อัปเดต: เป็นเวอร์ชันล่าสุดแล้ว');
    }
    return res;
  }

  /**
   * Install the new content.
   *
   * The backend refuses while a run is in flight, and says so — the update
   * waits for the turn to end rather than swapping files under it. When the
   * content is in place the backend restarts, and the window waits for it and
   * reloads, so the window's own files are the new ones.
   */
  async function applyUpdate() {
    const res = await rpc('update.apply').catch((err) => ({ ok: false, reason: err?.message ?? String(err) }));
    if (!res?.ok) {
      addCommandOut(`อัปเดตไม่สำเร็จ — ${res?.reason ?? 'ไม่ทราบสาเหตุ'}`);
      return;
    }
    addCommandOut(`อัปเดตแล้ว — ${res.version} · กำลังเปิดใหม่เพื่อใช้`);
    await waitForBackend();
    location.reload();
  }

  /** The backend restarts so the new content can take over; wait for it. */
  async function waitForBackend() {
    setHint('กำลังเปิดใหม่เพื่อใช้เวอร์ชันใหม่…', true);
    // The window is about to be reloaded, and a reload looks like a dead app
    // for as long as it takes: the bar keeps beating, with the words that say
    // what is happening.
    setWorking(true, { label: 'กำลังเปิดใหม่…' });
    for (let i = 0; i < 60; i += 1) {
      await new Promise((r) => setTimeout(r, 500));
      const back = await rpc('status').then(() => true).catch(() => false);
      if (back) return true;
    }
    setHint('กำลังเปิดใหม่… ถ้ายังไม่ขึ้น ให้ปิดแล้วเปิดแอปอีกครั้ง');
    return false;
  }

  /**
   * Hand the app over to the installer.
   *
   * The binary is replaced by the installer, and a running binary is locked:
   * so the app closes, the installer runs, and the app comes back. The backend
   * refuses while a run is in flight, and refuses an UNSIGNED installer — an
   * app that downloads and runs an unsigned installer on its own is the worm
   * shape, and the Windows installer is unsigned today. The refusal says so,
   * rather than the button failing silently.
   */
  async function installShellUpdate() {
    const res = await rpc('update.install').catch((err) => ({ ok: false, reason: err?.message ?? String(err) }));
    if (!res?.ok) {
      addCommandOut(`ติดตั้งไม่สำเร็จ — ${res?.reason ?? 'ไม่ทราบสาเหตุ'}`);
      return;
    }
    addCommandOut('กำลังปิดแอปเพื่อติดตั้ง…');
    setHint('กำลังติดตั้งเวอร์ชันใหม่ — แอปจะเปิดใหม่เอง', true);
  }

  /**
   * The transcript was emptied under the banners (a new session, a project
   * switch): the bars went with it, but the syncs still hold their
   * references — they would see the state still failing and a bar "already
   * up", and the notice would never come back. Forget them; the next poll
   * repaints the ones that still apply.
   */
  function reset() {
    extensionTokenBar = null;
    catalogBar = null;
    updateBar = null;
    shownUpdateKey = '';
  }

  return { syncExtensionToken, syncCatalogBanner, hasConversation, showWelcome, hideWelcome, refreshReadiness, checkForUpdate, reset };
}
