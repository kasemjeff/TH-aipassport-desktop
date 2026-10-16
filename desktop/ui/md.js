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
