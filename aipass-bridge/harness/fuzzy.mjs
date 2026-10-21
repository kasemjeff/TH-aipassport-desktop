/**
 * Fuzzy matching: the word a person types, and the many paths it could mean.
 *
 * Every quick-open in the world does this — the characters of the word must
 * appear in the text in order, but they need not sit next to each other.
 * "apjs" finds "app.js"; "app" finds "apply.mjs" and "aipass-bridge/app.js".
 *
 * The score says how GOOD the match is, so the list can be ordered:
 *
 *   - the file name beats a folder name (a person remembers the file)
 *   - the start of a word beats the middle of one
 *   - a run of letters beats the same letters scattered
 *   - a tight span beats a scattered one
 *   - a short path beats a long one
 *
 * The hits are the positions in the text that matched, so the window can pick
 * them out — the reader sees WHY a row is in the list, not only that it is.
 *
 * THE MATCH IS A SMALL DYNAMIC PROGRAM, not a walk.
 *
 * A greedy matcher takes the first place a letter fits, and that is wrong
 * often enough to be felt: in "xa_b", the word "ab" fits the "a" that begins
 * a word (the second one) far better than the "a" buried inside "xa" — but
 * the greedy one takes the first and never knows. So every position of the
 * text is tried against every letter of the word, and the best path through
 * them wins. It costs a little more per path and it is right more often,
 * which is the whole trade a quick-open is making.
 */

const SEPARATORS = new Set([' ', '.', '_', '-', '/', '\\', ':', '@']);

/** ASCII-only lowercasing: the length must not change, or the hit positions
 *  would point at the wrong characters. */
const lower = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** A camelCase turn: the shape of a word that has no separator. */
const isCaseTurn = (text, i) => {
  const c = text[i];
  const p = text[i - 1];
  if (!c || !p) return false;
  return c === c.toUpperCase() && c !== c.toLowerCase() && p === p.toLowerCase() && p !== p.toUpperCase();
};

/** What one character of the text is worth in the match. */
function charBonus(text, j, run) {
  let b = 8 + 6 * (run - 1);
  if (j === 0) b += 18; // the very first character
  else if (SEPARATORS.has(text[j - 1])) b += 14; // the start of a word
  else if (isCaseTurn(text, j)) b += 10; // a camelCase turn
  return b;
}

/**
 * The best way the word fits the text: every way it could, and the best one.
 *
 * @returns {{score: number, hits: number[]}|null} null when it does not fit
 */
function bestMatch(query, text) {
  const m = query.length;
  const n = text.length;
  if (!m) return { score: 0, hits: [] };
  if (!n || !text.includes(query[0])) return null;
  // rows[i][j] — the word's first i+1 letters, with the i-th of them sitting
  // on the text's j-th character.
  const rows = [];
  for (let i = 0; i < m; i++) {
    const row = new Array(n).fill(null);
    // The best entry of the row above, before this position: the best way to
    // have matched the word so far.
    let best = null;
    for (let j = 0; j < n; j++) {
      if (text[j] === query[i]) {
        let cand = null;
        if (i > 0) {
          // The letter right before this one, matched right before it: a run.
          const prev = j > 0 ? rows[i - 1][j - 1] : null;
          if (prev) cand = { score: prev.score + charBonus(text, j, prev.run + 1), at: j, from: j - 1, row: i, run: prev.run + 1 };
          // Or any earlier match — the best one so far.
          if (best) {
            const s = best.score + charBonus(text, j, 1);
            if (!cand || s > cand.score) cand = { score: s, at: j, from: best.at, row: i, run: 1 };
          }
        } else {
          cand = { score: charBonus(text, j, 1), at: j, from: -1, row: i, run: 1 };
        }
        row[j] = cand;
      }
      // The running best for the next position, taken from the row above.
      if (i > 0) {
        const prev = rows[i - 1][j];
        if (prev && (!best || prev.score > best.score)) best = prev;
      }
    }
    rows.push(row);
  }
  // The best ending, and the way back through the rows.
  let end = null;
  for (const entry of rows[m - 1]) {
    if (entry && (!end || entry.score > end.score)) end = entry;
  }
  if (!end) return null;
  const hits = [];
  for (let node = end; node; node = node.from >= 0 ? rows[node.row - 1][node.from] : null) {
    hits.push(node.at);
    if (node.from < 0) break;
  }
  hits.reverse();
  const first = hits[0];
  const last = hits[hits.length - 1];
  // A tight span is a better match than a scattered one.
  let score = end.score + Math.max(0, 24 - (last - first + 1 - m));
  // A short path is a better match than a long one.
  score -= Math.min(12, Math.floor(text.length / 10));
  return { score, hits };
}

/**
 * Match a word against a path.
 *
 * The file name is tried first: it is what a person remembers, and a word
 * that fits it is a better answer than one that fits a folder two levels up.
 *
 * @returns {{score: number, hits: number[]}|null} null when it does not match
 */
export function fuzzyMatch(query, path) {
  const q = lower(String(query ?? ''));
  const text = String(path ?? '');
  if (!q) return { score: 0, hits: [] };
  const cut = text.lastIndexOf('/');
  const name = text.slice(cut + 1);
  const inName = bestMatch(q, lower(name));
  if (inName) return { score: inName.score + 30, hits: inName.hits.map((i) => i + cut + 1) };
  const whole = bestMatch(q, lower(text));
  if (!whole) return null;
  return whole;
}
