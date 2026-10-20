// The pre-tool argument guard, Thai pack.
//
// Two failure shapes that live in a call's argument rather than its intent:
//
//   - Invisible characters pasted into a path (ZWSP, ZWNJ neighbours, NBSP)
//     and Thai digits pasted into a line range make an argument that LOOKS
//     right and resolves to nothing. The guard never rewrites the first
//     attempt: the call runs as written, and only a refusal earns one retry
//     with the argument normalized — strip what cannot be seen, swap Thai
//     digits for Arabics. A retry that matches says so in the result, so the
//     model learns the shape of its mistake instead of the guard hiding it.
//   - A Buddhist-era year in a machine-facing value (`run` command, `git`
//     message): people write 2569 meaning 2026. The guard appends an advisory
//     note; it never rewrites the command, and it never touches file content,
//     because a wrong year's error is theirs to see. Content may legitimately
//     use พ.ศ. — the note is only for values a machine will parse.
//
// Pure helpers: the loop decides when to call them, tests call them directly.
import { stripInvisibles, toArabicDigits, beYearsIn } from './lang.mjs';

/** Call kinds whose `arg` names a path (or a path plus a line range). */
export const PATHY = new Set(['read', 'list', 'write', 'replace', 'delete', 'move', 'attach', 'symbols']);

/**
 * Normalized retries for a path argument, in order: invisible characters
 * stripped, Thai digits swapped for Arabics, then both. Identical strings are
 * dropped; an argument with nothing to fix yields an empty list.
 * @param {string} arg
 * @returns {string[]}
 */
export function pathVariants(arg) {
  const raw = String(arg);
  const out = [];
  const push = (v) => { if (v && v !== raw && !out.includes(v)) out.push(v); };
  const noInvis = stripInvisibles(raw);
  push(noInvis);
  push(toArabicDigits(raw));
  push(toArabicDigits(noInvis));
  return out;
}

/**
 * The advisory note for a Buddhist-era year in a machine-facing value, or
 * null when the text carries none.
 * @param {string} text
 * @returns {string|null}
 */
export function beYearNote(text) {
  const hit = beYearsIn(text)[0];
  if (!hit) return null;
  return `note: ${hit.year} looks like a Buddhist-era year (= ${hit.ce} CE). `
    + `Machine-facing values (commands, paths, timestamps) use CE; พ.ศ. belongs in text read by people.`;
}
