/* A markdown renderer small enough to read in one sitting.
 *
 * Everything is escaped first, then the shapes are applied to the escaped
 * text — the model's output is untrusted input, never markup. Covers what a
 * coding agent actually emits: fenced code, lists, headings, tables of words,
 * emphasis, links, and code spans. Anything else falls through as a paragraph.
 */

const escapeHtml = (s) => s
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const inline = (s) => escapeHtml(s)
  .replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`)
  .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

/**
 * Where a streamed source stops being re-renderable: `stable` is every block
 * whose rendering can no longer change as more text arrives, `tail` is the one
 * construct still open at the end (the growing paragraph, list or code fence).
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
  let openKind = null;   // 'para' | 'ul' | 'ol' | 'fence'
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
    const ul = /^\s*[-*+]\s+/.test(line);
    const ol = /^\s*\d+[.)]\s+/.test(line);
    if (ul || ol) {
      const kind = ul ? 'ul' : 'ol';
      if (openKind !== kind) { openAt = at; openKind = kind; }
      at += line.length + 1;
      continue;
    }
    if (!line.trim()) { close(); at += line.length + 1; continue; }
    if (openKind !== 'para') { openAt = at; openKind = 'para'; }
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

  for (const line of lines) {
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
    if (!line.trim()) { flushPara(); flushList(); continue; }
    flushList();
    para.push(line.trim());
  }
  if (fence !== null) out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
  flushPara(); flushList();
  return out.join('\n');
}

export { escapeHtml, inline };
