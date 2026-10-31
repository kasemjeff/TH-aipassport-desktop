// text.mjs — shared tokenization and excerpting for retrieval and recall.
export const EXCERPT_CAP = 280;

const STOP = new Set(['the', 'and', 'for', 'with', 'how', 'what', 'where', 'why', 'is', 'are', 'of', 'to', 'in', 'on', 'a', 'an', 'it', 'this', 'that', 'or', 'be', 'as', 'at', 'by', 'from', 'not', 'but', 'if', 'so', 'do', 'does', 'did', 'has', 'have', 'had', 'was', 'were', 'will', 'can', 'could', 'should', 'would', 'may', 'might', 'about', 'into', 'than', 'then', 'there', 'here', 'when', 'which', 'who', 'whom', 'whose', 'ของ', 'และ', 'ที่', 'การ', 'ความ', 'ให้', 'ได้', 'เป็น', 'มี', 'ใน', 'ว่า', 'จะ', 'ไป', 'มา', 'ไม่', 'นี้', 'นั้น', 'นั่น', 'ด้วย', 'แต่', 'หรือ', 'กับ', 'จาก', 'ถึง', 'เพื่อ', 'ตาม', 'อย่าง', 'คือ', 'เพราะ', 'หาก', 'เมื่อ']);

let SEG_EN = null;
let SEG_TH = null;
try { SEG_EN = new Intl.Segmenter('en', { granularity: 'word' }); } catch {}
try { SEG_TH = new Intl.Segmenter('th', { granularity: 'word' }); } catch {}

export function tokenize(text) {
  const out = [];
  const s = String(text ?? '').normalize('NFKC');
  const hasThai = /[฀-๿]/.test(s);
  const seg = hasThai ? SEG_TH : SEG_EN;
  const segments = seg ? [...seg.segment(s)] : [{ segment: s, isWordLike: true }];
  for (const segObj of segments) {
    if (!segObj.isWordLike) continue;
    const w = segObj.segment;
    const parts = w.split(/[_\-]+/).flatMap((p) => p.replace(/([a-z])([A-Z])/g, '$1 $2').split(/\s+/));
    for (const p of parts) {
      const low = p.toLowerCase().trim();
      if (low.length < 2) continue;
      if (STOP.has(low)) continue;
      out.push(low);
    }
    if (/[฀-๿]/.test(w)) {
      const chars = [...w];
      for (let i = 0; i + 3 <= chars.length; i++) {
        out.push('t:' + chars.slice(i, i + 3).join(''));
      }
    }
  }
  return out;
}

export function queryWords(query) {
  const out = [];
  for (const w of String(query ?? '').toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (w.length < 2) continue;
    if (!out.includes(w)) out.push(w);
  }
  return out;
}

export function excerptOf(text, words, cap = EXCERPT_CAP, opts = {}) {
  const keepLines = !!(opts && opts.keepLines);
  const flat = keepLines
    ? String(text ?? '').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim()
    : String(text ?? '').replace(/\s+/g, ' ').trim();
  const low = flat.toLowerCase();
  const ws = Array.isArray(words) ? words : [words];
  let at = -1;
  for (const w of ws) {
    const i = low.indexOf(String(w ?? '').toLowerCase());
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return flat.slice(0, cap);
  const before = Math.min(80, Math.floor(cap / 4));
  const start = Math.max(0, at - before);
  // Fill the window: extend to the full cap from `start` rather than
  // stopping at `at + cap - before`, which left the tail short.
  const end = Math.min(flat.length, start + cap);
  const slice = flat.slice(start, end).trim();
  return (start > 0 ? '… ' : '') + slice + (end < flat.length ? ' …' : '');
}
