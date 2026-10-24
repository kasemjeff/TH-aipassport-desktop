// The files panel: the tree of the project, and the search over it.
//
// The panel used to list one directory and stop: clicking a folder did
// nothing at all. It now walks, keeps a trail so you can get back, and the
// field under the heading searches the WHOLE project — a folder with a
// hundred files is a list nobody scrolls, and a project with a thousand files
// is a tree nobody can walk in their head.
//
// The field has two modes, and the button at its end says which one is on:
// by the NAME of a file, or by what is WRITTEN in it.


/**
 * The files panel: the tree, the trail and the search.
 *
 * @param {object} ctx the window it draws into
 */
export function createFilesPanel(ctx) {
  const { $, el, state, rpc, clickable, friendly, addNote, addCommandOut } = ctx;


// The file panel used to list one directory and stop: clicking a folder did
// nothing at all. It now walks, keeps a trail so you can get back, and the
// field under the heading searches the WHOLE project — a folder with a
// hundred files is a list nobody scrolls, and a project with a thousand files
// is a tree nobody can walk in their head.
//
// The field has two modes, and the button at its end says which one is on:
// by the NAME of a file, or by what is WRITTEN in it.
const filesState = { dir: '.', query: '', mode: 'name', entries: [], results: null, error: null, searching: false };

/** The type of a file, from its name: the shape tells you what a file is
 *  before the name is read. */
const CODE_EXT = new Set(['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rs', 'go', 'java', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'rb', 'php', 'sh', 'ps1', 'css', 'scss', 'html', 'json', 'yaml', 'yml', 'toml', 'sql', 'lua', 'swift', 'kt', 'vue', 'svelte']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
const fileIcon = (name, dir) => {
  if (dir) return 'ico-dir';
  const ext = String(name).split('.').pop()?.toLowerCase() ?? '';
  if (IMAGE_EXT.has(ext)) return 'ico-image';
  if (CODE_EXT.has(ext)) return 'ico-code';
  return 'ico-file';
};

/** A file's size, the way a person reads it: 812 B, 12 KB, 3.4 MB. */
function fileSize(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** The name of the project the window is on — the first step of the trail. */
function projectLabel() {
  const opt = $('project')?.selectedOptions?.[0];
  const named = (opt?.textContent ?? '').trim();
  if (named) return named;
  const root = String(state.root ?? '').split(/[\\/]/).filter(Boolean).pop();
  return root || 'โปรเจกต์';
}

/** A path in two: the folder it lives in, and the name it has there. */
function splitPath(p) {
  const cut = String(p ?? '').lastIndexOf('/');
  return {
    dir: cut === -1 ? '' : String(p).slice(0, cut),
    name: cut === -1 ? String(p) : String(p).slice(cut + 1),
    start: cut + 1,
  };
}

/**
 * The text with the letters that matched picked out.
 *
 * A search that shows what it matched is a search you can trust: the reader
 * sees WHY the row is in the list, and not only that it is.
 */
function markText(text, positions) {
  const box = el('span');
  const hit = new Set(positions ?? []);
  let buf = '';
  let on = false;
  const flush = () => {
    if (!buf) return;
    box.append(on ? el('span', 'hl', buf) : document.createTextNode(buf));
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const isHit = hit.has(i);
    if (isHit !== on) { flush(); on = isHit; }
    buf += text[i];
  }
  flush();
  return box;
}

/**
 * The trail of the tree: the folders above the one you are in, each one a
 * way back. The head of the section says where you are; this says how to
 * get out again.
 */
function renderCrumbs(dir, searching = false) {
  const box = $('files-crumbs');
  if (!box) return;
  box.textContent = '';
  const parts = dir === '.' ? [] : dir.split('/').filter(Boolean);
  const root = el('button', 'crumb', projectLabel());
  root.title = 'กลับไปที่รากของโปรเจกต์';
  root.onclick = () => openFolder('.');
  box.append(root);
  let path = '';
  for (const part of parts) {
    path = path ? `${path}/${part}` : part;
    const target = path;
    const seg = el('button', 'crumb', part);
    seg.title = target;
    seg.onclick = () => openFolder(target);
    box.append(el('span', 'crumb-sep', '›'));
    box.append(seg);
  }
  // At the root there is no trail to show: the head already names the folder.
  // And while the search is on there is no folder to be in at all.
  box.classList.toggle('hidden', parts.length === 0 || searching);
}

/**
 * Open a folder: the search is over, and the panel is in that folder now.
 *
 * A search result that is a folder is a way INTO it — and once you are in it,
 * the list is that folder, not the results of the word you typed.
 */
function openFolder(rel) {
  filesState.query = '';
  filesState.results = null;
  filesState.searching = false;
  const input = $('file-filter');
  if (input) input.value = '';
  void refreshFiles(rel);
}

/**
 * The list of one folder — or the list of what the search found.
 *
 * The field under the heading has two modes, and the list says which one it
 * is: empty, the panel walks the folder you are in (with the trail above it);
 * with a word in it, the panel answers from the whole project and every row
 * carries the folder it lives in.
 */
function renderFiles() {
  const ul = $('files');
  const dir = filesState.dir;
  const query = filesState.query;
  const searching = Boolean(query);
  const byContent = searching && filesState.mode === 'content';
  const head = $('files-head');
  if (head) {
    head.textContent = searching
      ? (byContent ? `พบในไฟล์: “${query}”` : `ผลการค้นหา “${query}”`)
      : (dir === '.' ? 'ไฟล์ในโปรเจกต์' : dir);
  }
  renderCrumbs(dir, searching);
  ul.textContent = '';

  const all = searching ? (filesState.results ?? []) : (filesState.entries ?? []);
  const count = $('files-count');
  if (count) {
    count.textContent = searching
      ? (filesState.searching ? '…' : (all.length ? String(all.length) : ''))
      : (all.length ? String(all.length) : '');
  }

  // A folder that could not be read says so — and keeps saying so, even when
  // the filter is typed into it.
  if (filesState.error) {
    renderFilesError(filesState.error, dir);
    return;
  }

  if (searching && filesState.searching) {
    ul.append(el('li', 'dim', byContent ? 'กำลังอ่านไฟล์ในโปรเจกต์…' : 'กำลังค้นหา…'));
    return;
  }
  if (searching && !all.length) {
    ul.append(el('li', 'dim', byContent ? `ไม่พบคำว่า “${query}” ในไฟล์ของโปรเจกต์` : `ไม่พบไฟล์ที่ตรงกับ “${query}”`));
    return;
  }
  if (!searching && !all.length) {
    ul.append(el('li', 'dim', dir === '.' ? 'โปรเจกต์นี้ยังไม่มีไฟล์' : 'โฟลเดอร์นี้ว่าง'));
    return;
  }

  // The way up: one row, and it names the folder it takes you to. In the
  // search there is no folder to be in, so there is no way up.
  if (!searching && dir !== '.') {
    const parent = dir.split('/').slice(0, -1).join('/') || '.';
    const up = el('li', 'up');
    up.append(el('span', 'ico ico-up'));
    up.append(el('span', 'name', parent === '.' ? projectLabel() : parent.split('/').pop()));
    clickable(up, () => openFolder(parent));
    ul.append(up);
  }

  for (const e of all.slice(0, 300)) {
    // A search result gets two lines: the file, and where it is. A folder row
    // in the tree is one line — the tree already says where it is.
    const li = el('li', searching ? 'file-row multi' : 'file-row');
    const parts = splitPath(e.path ?? e.name ?? '');
    const rel = searching ? e.path : (dir === '.' ? e.name : `${dir}/${e.name}`);
    li.append(el('span', `ico ${fileIcon(parts.name, e.dir)}`));
    if (byContent) {
      li.append(el('span', 'name', parts.name));
      // The line that matched, with the word in it picked out, and the place
      // it was found in front of it.
      const at = Math.max(0, Number(e.at ?? 0));
      const line = el('span', 'line');
      line.append(el('span', 'at', `${parts.dir || 'โปรเจกต์'}:${e.line}`));
      line.append(document.createTextNode(' '));
      line.append(markText(String(e.text ?? ''), Array.from({ length: query.length }, (_, i) => at + i)));
      li.append(line);
      li.title = `${rel}:${e.line}\n${e.text}`;
      clickable(li, () => void ctx.openFile(rel, e.line));
    } else {
      const nameHits = (e.hits ?? []).filter((i) => i >= parts.start).map((i) => i - parts.start);
      // A folder keeps its slash in the tree; in the search the path below
      // the name says where it is, and a slash there would be noise.
      const label = searching ? parts.name : (e.dir ? `${e.name}/` : e.name);
      const nameBox = el('span', 'name');
      if (searching && nameHits.length) nameBox.append(markText(label, nameHits));
      else nameBox.textContent = label;
      li.append(nameBox);
      if (searching) li.append(el('span', 'path', parts.dir || 'โปรเจกต์'));
      const size = fileSize(e.size);
      if (size && !searching) li.append(el('span', 'sub', size));
      li.title = [rel, size, e.mtime ? `แก้ล่าสุด ${new Date(e.mtime).toLocaleString()}` : ''].filter(Boolean).join('\n');
      if (e.dir) {
        clickable(li, () => openFolder(rel));
      } else {
        clickable(li, () => void ctx.openFile(rel));
      }
    }
    if (!byContent && !e.dir) {
      // Attach straight from the panel: the file is right there, and a picker
      // is a detour.
      const attach = el('button', 'mini', 'แนบ');
      attach.onclick = async (ev) => {
        ev?.stopPropagation?.();
        const item = await rpc('attachment.stage', { path: rel }).catch((err) => ({ error: err.message }));
        if (item.error) { addNote(`แนบไม่ได้: ${friendly(item.error)}`); return; }
        state.attachments.set(item.id, item);
        ctx.renderAttachments();
        addCommandOut(`แนบแล้ว: ${item.name}`);
      };
      li.append(attach);
    }
    ul.append(li);
  }
  if (all.length > 300) {
    ul.append(el('li', 'dim', `แสดง 300 จาก ${all.length} — กรองเพื่อหาให้ครบ`));
  }
}

/** The list could not be read. Say so, and offer the one thing that fixes
 *  it: reading it again. */
function renderFilesError(message, dir) {
  const ul = $('files');
  ul.textContent = '';
  const li = el('li', 'dim');
  li.append(el('span', null, `อ่านไฟล์ไม่ได้: ${friendly(message)}`));
  const retry = el('button', 'mini', 'ลองใหม่');
  retry.onclick = () => {
    // The same question, the same way: a search that failed is a search to
    // run again, and a folder that failed is a folder to read again.
    if (filesState.query) {
      filesState.searching = true;
      void searchFiles(filesState.query);
      return;
    }
    void refreshFiles(dir);
  };
  li.append(retry);
  ul.append(li);
}

async function refreshFiles(dir = filesState.dir) {
  const target = dir || '.';
  const head = $('files-head');
  if (head) head.textContent = target === '.' ? 'ไฟล์ในโปรเจกต์' : target;
  // The button turns while the folder is being read: the list is a picture of
  // the disk, and the reader should see that a new one is being taken.
  const btn = $('files-refresh');
  btn?.classList.add('busy');
  const out = await rpc('fs.list', { dir: target }).catch((err) => ({ error: err.message }));
  btn?.classList.remove('busy');
  filesState.dir = target;
  filesState.error = out?.error ? String(out.error) : null;
  filesState.entries = Array.isArray(out) ? out : [];
  renderFiles();
}

/**
 * The search: every file of the project whose path holds the word — or, in
 * the other mode, every line of every file that holds it.
 *
 * The backend keeps the index of the tree for a minute, so this is a filter
 * and not a walk — the difference between a search that keeps up with the
 * keyboard and one that does not.
 */
async function searchFiles(query) {
  const byContent = filesState.mode === 'content';
  const out = await rpc(byContent ? 'fs.grep' : 'fs.search', byContent ? { query, limit: 60 } : { query, limit: 120 })
    .catch((err) => ({ error: err.message }));
  if (filesState.query !== query) return; // a newer word won the race
  filesState.searching = false;
  if (out?.error) {
    filesState.error = String(out.error);
    filesState.results = [];
    renderFiles();
    return;
  }
  filesState.error = null;
  filesState.results = Array.isArray(out) ? out : [];
  renderFiles();
}

/**
 * The mode of the field: by the NAME of a file, or by what is written in it.
 *
 * The button at the end of the field says which one is on, and the shortcut
 * (Ctrl+Shift+F) flips it — the two ways every editor offers a grep.
 */
function setSearchMode(mode) {
  if (filesState.mode === mode) return;
  filesState.mode = mode;
  filesState.results = null;
  filesState.searching = false;
  filesState.error = null;
  const btn = $('file-mode');
  btn?.classList.toggle('content', mode === 'content');
  btn?.setAttribute('aria-pressed', String(mode === 'content'));
  const input = $('file-filter');
  if (input) {
    input.placeholder = mode === 'content' ? 'ค้นหาคำในไฟล์ของโปรเจกต์…' : 'ค้นหาไฟล์ในโปรเจกต์…';
    input.title = mode === 'content'
      ? 'ค้นหาคำในเนื้อไฟล์ (Ctrl+Shift+F)'
      : 'ค้นหาไฟล์ด้วยชื่อ (Ctrl+P)';
  }
  const query = ($('file-filter')?.value ?? '').trim();
  if (query) {
    filesState.query = query;
    filesState.searching = true;
    renderFiles();
    void searchFiles(query);
    return;
  }
  renderFiles();
}
$('file-mode').onclick = () => setSearchMode(filesState.mode === 'content' ? 'name' : 'content');

// The field has two modes, and the list says which one it is: empty, the
// panel walks the folder you are in; with a word in it, the panel answers
// from the whole project.
let fileSearchTimer = null;
$('file-filter').oninput = () => {
  const query = ($('file-filter').value ?? '').trim();
  filesState.query = query;
  clearTimeout(fileSearchTimer);
  if (!query) {
    filesState.results = null;
    filesState.searching = false;
    filesState.error = null;
    renderFiles();
    return;
  }
  filesState.searching = true;
  renderFiles();
  fileSearchTimer = setTimeout(() => void searchFiles(query), 180);
};

// The keyboard, in the field: Enter opens what the search found, and ↓ walks
// down into the results. A field you can type in but not act on is a form,
// not a tool.
$('file-filter').addEventListener('keydown', (ev) => {
  const first = (filesState.results ?? filesState.entries ?? [])[0];
  if (ev.key === 'Enter' && first) {
    ev.preventDefault();
    const rel = filesState.query
      ? first.path
      : (filesState.dir === '.' ? first.name : `${filesState.dir}/${first.name}`);
    if (first.dir) openFolder(rel);
    // The line comes with the result: a content search found "notes.md:42",
    // and the file opens there — the same place the click on that row opens
    // it. Without it the reader is sent to the top of the file.
    else void ctx.openFile(rel, first.line ?? null);
    return;
  }
  if (ev.key === 'ArrowDown') {
    const row = [...($('files')?.children ?? [])].find((li) => li.tabIndex === 0);
    if (!row) return;
    ev.preventDefault();
    row.focus?.();
    row.scrollIntoView?.({ block: 'nearest' });
  }
});

// The list is a picture of the disk, and a picture goes stale while you work.
$('files-refresh').onclick = () => {
  // A fresh index too: the tree may have changed under the search as well.
  filesState.results = null;
  void refreshFiles();
};


  return { filesState, renderFiles, refreshFiles, searchFiles, openFolder, setSearchMode };
}

export default createFilesPanel;
