/* The wire spellings — the placeholders the edge in front of de.aipass.net
 * needs — are the WAF's, and its table lives in the harness: one table, one
 * owner. The window asks the backend for those rules at boot and keeps them
 * here, so the text on screen is the text the model wrote. Until the table
 * arrives the text is shown as it came: a plain answer beats a broken one. */

let rules = [];

/**
 * The restore rules, rebuilt from the backend's table. A rule that will not
 * compile is dropped rather than thrown — a table that cannot be read must
 * not take the window down with it.
 * @param {Array<[string, string, string]>} pairs
 */
export function setRestoreTable(pairs) {
  rules = (Array.isArray(pairs) ? pairs : [])
    .filter((p) => Array.isArray(p) && p.length === 3)
    .map(([source, flags, to]) => {
      try { return [new RegExp(source, flags), to]; } catch { return null; }
    })
    .filter(Boolean);
}

/**
 * The text as it was written: every wire spelling put back.
 * @param {string} text
 * @returns {string}
 */
export function restoreText(text) {
  if (typeof text !== 'string') return '';
  if (!rules.length) return text;
  return rules.reduce((acc, [re, to]) => acc.replace(re, to), text);
}
