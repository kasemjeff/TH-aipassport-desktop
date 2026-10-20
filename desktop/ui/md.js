/* A markdown renderer small enough to read in one sitting.
 *
 * Everything is escaped first, then the shapes are applied to the escaped
 * text — the model's output is untrusted input, never markup. Covers what a
 * coding agent actually emits: fenced code, lists, headings, pipe tables,
 * images, standalone video URLs, emphasis, links, and code spans. Anything
 * else falls through as a paragraph.
 */

const escapeHtml = (s) => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

// Media is only ever fetched from the open web, never from a scheme that can
// run code (`javascript:`, `data:`). The same rule as links.
const safeSrc = (src) => {
  const s = String(src ?? '').trim();
  return /^https?:\/\/[^\s]+$/i.test(s) ? s : null;
};

const VIDEO_SRC = /\.(?:mp4|m4v|webm|ogv|ogg|mov)(?:[?#][^\s]*)?$/i;
const looksLikeVideo = (src, label = '') => VIDEO_SRC.test(src) || VIDEO_SRC.test(label.trim());

const mediaTag = (kind, src, alt = '') => {
  const href = escapeHtml(src);
  return kind === 'video'
    ? `<video class="md-video" controls preload="metadata" playsinline src="${href}"></video>`
    : `<img class="md-image" src="${href}" alt="${escapeHtml(alt)}" loading="lazy" referrerpolicy="no-referrer">`;
};

const inline = (s) => {
  // Code spans and media are complete HTML once built. Stash them behind a
  // sentinel so the emphasis passes cannot rewrite an `*` inside a URL, and a
  // quoted image in backticks is never fetched.
  const kept = [];
  const stash = (html) => `\u0000${kept.push(html) - 1}\u0000`;
  let out = escapeHtml(s)
    .replace(/`([^`\n]+)`/g, (_, c) => stash(`<code>${c}</code>`))
    .replace(/!\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)/g, (whole, alt, src) => {
      // Everything above is already escaped; src/alt can go straight into the
      // attributes. A video written as an image is a link while inline — only a
      // line of its own can grow a player.
      if (!safeSrc(src)) return whole;
      if (looksLikeVideo(src, alt)) return stash(`<a href="${src}" target="_blank" rel="noreferrer">${alt || 'video'}</a>`);
      return stash(`<img class="md-image md-image-inline" src="${src}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer">`);
    });
  out = out
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)]);
};

/* A line that is nothing but an image or a video URL becomes a block of its
 * own. This is also what splitMarkdownStable looks for, so the two functions
 * must agree on the shape. */
const mediaLine = (line) => {
  const image = line.match(/^\s*!\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)\s*$/);
  if (image && safeSrc(image[2])) {
    return { kind: looksLikeVideo(image[2], image[1]) ? 'video' : 'image', src: image[2], alt: image[1].trim() };
  }
  const link = line.match(/^\s*\[([^\]\n]*)\]\((https?:\/\/[^)\s]+)\)\s*$/);
  if (link && safeSrc(link[2]) && looksLikeVideo(link[2], link[1])) {
    return { kind: 'video', src: link[2], alt: link[1].trim() };
  }
  const bare = line.match(/^\s*(https?:\/\/[^\s]+)\s*$/);
  if (bare && looksLikeVideo(bare[1]) && safeSrc(bare[1])) {
    return { kind: 'video', src: bare[1], alt: '' };
  }
  return null;
};

const mediaBlock = (media) => {
  const tag = mediaTag(media.kind, media.src, media.alt);
  const caption = media.alt ? `<figcaption>${escapeHtml(media.alt)}</figcaption>` : '';
  return `<figure class="md-figure${media.kind === 'video' ? ' md-video-figure' : ''}">${tag}${caption}</figure>`;
};

/* A pipe row, with `\|` and pipes inside code spans kept in their cell. */
const splitTableRow = (line) => {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cell = '';
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '`') { code = !code; cell += ch; continue; }
    if (ch === '\\' && s[i + 1] === '|') { cell += '|'; i++; continue; }
    if (ch === '|' && !code) { cells.push(cell.trim()); cell = ''; continue; }
    cell += ch;
  }
  cells.push(cell.trim());
  return cells;
};

const isTableSeparator = (line) => {
  if (!line.includes('|')) return false;
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
};

const cellAlign = (cell) => {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
};

const tableHtml = (head, align, rows) => {
  const cell = (tag, text, i) => {
    const a = align[i];
    const cls = a ? ` class="al-${a}"` : '';
    return `<${tag}${cls}>${inline(text)}</${tag}>`;
  };
  const body = rows.length
    ? `<tbody>${rows.map((row) => `<tr>${head.map((_, i) => cell('td', row[i] ?? '', i)).join('')}</tr>`).join('')}</tbody>`
    : '';
  return `<div class="md-table-wrap"><table><thead><tr>${head.map((c, i) => cell('th', c, i)).join('')}</tr></thead>${body}</table></div>`;
};

/**
 * Where a streamed source stops being re-renderable: `stable` is every block
 * whose rendering can no longer change as more text arrives, `tail` is the one
 * construct still open at the end (the growing paragraph, list, table or code
 * fence).
 *
 * `paintAssistant` paints the two apart so a long answer stops re-parsing its
 * own finished prefix on every frame — the settled stretch is rendered once
 * and only the tail repaints. The split must be invisible: for any source,
 * `renderMarkdown(src)` equals the two pieces rendered and joined, and as the
 * source grows the stable piece only ever gains text (never rewrites), which is
 * what lets the window append instead of reset. Both properties are pinned in
 * test/ui-md.test.mjs.
 */
export function splitMarkdownStable(src) {
  const text = String(src ?? '').replace(/\r\n/g, '\n');
  let at = 0;            // char offset of the line being read
  let openAt = null;     // where the construct still open at the end began
  let openKind = null;   // 'para' | 'ul' | 'ol' | 'fence' | 'table'
  let fence = false;
  const close = () => { openAt = null; openKind = null; };
  for (const line of text.split('\n')) {
    if (fence) {
      if (/^\s*```\s*$/.test(line)) { fence = false; close(); }
      at += line.length + 1;
      continue;
    }
    if (/^\s*```(\S*)\s*$/.test(line)) { fence = true; openAt = at; openKind = 'fence'; at += line.length + 1; continue; }
    // Headings, rules and quote lines are whole in themselves (this renderer
    // closes each on its own line), the way renderMarkdown treats them.
    if (/^(#{1,4})\s+/.test(line) || /^\s*([-*_])\1{2,}\s*$/.test(line) || /^\s*>/.test(line)) { close(); at += line.length + 1; continue; }
    // A standalone image or video is likewise complete on its line.
    if (mediaLine(line)) { close(); at += line.length + 1; continue; }
    const ul = /^\s*[-*+]\s+/.test(line);
    const ol = /^\s*\d+[.)]\s+/.test(line);
    if (ul || ol) {
      const kind = ul ? 'ul' : 'ol';
      if (openKind !== kind) { openAt = at; openKind = kind; }
      at += line.length + 1;
      continue;
    }
    // A run of pipe lines may still turn into a table, so it stays open. If a
    // paragraph is already open the whole paragraph stays with it: a header
    // cannot be settled before its separator row arrives.
    if (line.includes('|') && openKind !== 'para') {
      if (openKind !== 'table') { openAt = at; openKind = 'table'; }
      at += line.length + 1;
      continue;
    }
    if (!line.trim()) { close(); at += line.length + 1; continue; }
    // A run of pipe lines that no separator turned into a table is just prose.
    // Keep its first line in the tail: the next prose line may join it into the
    // same paragraph, so settling it alone would paint two paragraphs.
    if (openKind === 'table') openKind = 'para';
    else if (openKind !== 'para') { openAt = at; openKind = 'para'; }
    at += line.length + 1;
  }
  const cut = openAt ?? text.length;
  return { stable: text.slice(0, cut), tail: text.slice(cut) };
}

export function renderMarkdown(src) {
  const text = String(src ?? '').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const out = [];
  let para = [];
  let list = null;
  let fence = null;
  let fenceLang = '';
  let code = [];

  const flushPara = () => {
    if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; }
  };
  const flushList = () => {
    if (!list) return;
    const tag = list === 'ul' ? 'ul' : 'ol';
    out.push(`<${tag}>${listItems.join('')}</${tag}>`);
    list = null;
    listItems = [];
  };
  let listItems = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence !== null) {
      if (new RegExp(`^\\s*\`\`\`\\s*$`).test(line)) {
        out.push(`<pre><code class="lang-${escapeHtml(fenceLang)}">${escapeHtml(code.join('\n'))}</code></pre>`);
        fence = null; code = [];
      } else code.push(line);
      continue;
    }
    const open = line.match(/^\s*```(\S*)\s*$/);
    if (open) { flushPara(); flushList(); fence = open[1] || ''; continue; }

    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) { flushPara(); flushList(); const n = heading[1].length; out.push(`<h${n}>${inline(heading[2])}</h${n}>`); continue; }

    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flushPara(); flushList(); out.push('<hr/>'); continue; }

    const media = mediaLine(line);
    if (media) { flushPara(); flushList(); out.push(mediaBlock(media)); continue; }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    if (ul) {
      flushPara();
      if (list !== 'ul') { flushList(); list = 'ul'; }
      listItems.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ol) {
      flushPara();
      if (list !== 'ol') { flushList(); list = 'ol'; }
      listItems.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushPara(); flushList();
      out.push(`<blockquote>${inline(line.replace(/^\s*>\s?/, ''))}</blockquote>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushPara(); flushList();
      const head = splitTableRow(line);
      const align = splitTableRow(lines[i + 1]).map(cellAlign);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows.push(splitTableRow(lines[i]));
        i++;
      }
      i--;
      out.push(tableHtml(head, align, rows));
      continue;
    }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    flushList();
    para.push(line.trim());
  }
  if (fence !== null) out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  flushPara(); flushList();
  return out.join('\n');
}

export { escapeHtml, inline };
