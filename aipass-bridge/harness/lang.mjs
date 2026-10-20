// @ts-check
// Thai-language helpers for the loop: digit conversion, invisible characters,
// Buddhist-era years, and the Thai-character ratio used by the reply-language
// check.
//
// Everything here is pure: no I/O, no options, no state. The ratio is a
// heuristic, not a tokenizer.

const THAI_BLOCK = /[\u0E01-\u0E5B]/;
const THAI_DIGIT_BLOCK = /[\u0E50-\u0E59]/;
const THAI_LETTER_GLOBAL = /[\u0E01-\u0E4F\u0E5A\u0E5B]/g;
const LATIN_LETTER_GLOBAL = /[A-Za-z]/g;

// Zero-width and formatting characters that silently break exact string
// compares. U+200C (ZWNJ) and U+200D (ZWJ) are deliberately NOT here: Thai
// orthography and emoji legitimately use them.
/** @type {Array<{ char: string, code: string, name: string, space: boolean }>} */
export const INVISIBLES = [
  { char: '\u200B', code: 'U+200B', name: 'zero-width space', space: false },
  { char: '\u200E', code: 'U+200E', name: 'left-to-right mark', space: false },
  { char: '\u200F', code: 'U+200F', name: 'right-to-left mark', space: false },
  { char: '\u2060', code: 'U+2060', name: 'word joiner', space: false },
  { char: '\uFEFF', code: 'U+FEFF', name: 'zero-width no-break space (BOM)', space: false },
  { char: '\u00A0', code: 'U+00A0', name: 'non-breaking space', space: true },
];

/** Is this a Thai letter (not a Thai digit)? @param {string} ch */
export const isThaiLetter = (ch) => THAI_BLOCK.test(ch) && !THAI_DIGIT_BLOCK.test(ch);

/** Thai digits ๐-๙ to their ASCII equivalents. @param {string} text */
export function toArabicDigits(text) {
  return String(text).replace(/[\u0E50-\u0E59]/g, (c) => String(c.charCodeAt(0) - 0x0E50));
}

/** Does the text contain any Thai digit? @param {string} text */
export const hasThaiDigits = (text) => THAI_DIGIT_BLOCK.test(String(text));

/**
 * Every invisible/formatting character in the text, with positions.
 * @param {string} text
 * @returns {Array<{ index: number, code: string, name: string, space: boolean }>}
 */
export function findInvisibles(text) {
  const out = [];
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    for (const inv of INVISIBLES) {
      if (s[i] === inv.char) {
        out.push({ index: i, code: inv.code, name: inv.name, space: inv.space });
        break;
      }
    }
  }
  return out;
}

/** Remove zero-width/formatting characters; non-breaking spaces become plain spaces. @param {string} text */
export function stripInvisibles(text) {
  let s = String(text);
  for (const inv of INVISIBLES) {
    s = s.split(inv.char).join(inv.space ? ' ' : '');
  }
  return s;
}

/**
 * Four-digit years that look like Buddhist-era years (2400-2699), with the
 * CE equivalent. Advisory only — content may legitimately use BE years.
 * @param {string} text
 * @returns {Array<{ year: number, ce: number }>}
 */
export function beYearsIn(text) {
  const out = [];
  const seen = new Set();
  for (const m of String(text).matchAll(/\d{4}/g)) {
    const year = Number(m[0]);
    if (year >= 2400 && year <= 2699 && !seen.has(year)) {
      seen.add(year);
      out.push({ year, ce: year - 543 });
    }
  }
  return out;
}

/** Drop fenced code blocks, inline code, and URLs before looking at prose. @param {string} text */
export function withoutTechnical(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b[\w.-]+@[\w.-]+\b/g, ' ');
}

/**
 * Share of Thai letters among all letters (Thai + Latin), ignoring code and
 * URLs. A tech-heavy Thai sentence will sit well below 1.0 on purpose.
 * @param {string} text
 * @returns {{ thai: number, latin: number, ratio: number, letters: number }}
 */
export function thaiRatio(text) {
  const prose = withoutTechnical(text);
  const thai = (prose.match(THAI_LETTER_GLOBAL) ?? []).length;
  const latin = (prose.match(LATIN_LETTER_GLOBAL) ?? []).length;
  const letters = thai + latin;
  return { thai, latin, ratio: letters === 0 ? 0 : thai / letters, letters };
}
