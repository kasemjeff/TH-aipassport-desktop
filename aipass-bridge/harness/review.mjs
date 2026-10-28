// @ts-check
// A review run: read a change, report what is wrong, stage nothing.
//
// Two pieces live here. `reviewBrief` is the task a review run is given — the
// staged diff (or a git ref to compare against) plus the findings shape — and
// `hasFindings` is the one check the DONE gate makes on the closing message:
// a review that ends without either a `path:line` finding or the words "no
// findings" did not review anything.
//
// The floor itself is not here: the loop refuses every mutating marker and the
// tool table is built read-only, so a model that ignores this text still
// cannot stage a change.
/** How much of a staged diff rides the first message. */
export const REVIEW_DIFF_CAP = 24_000;

const SEVERITY = /\b(?:blocker|major|minor)\b/i;
const ANCHOR = /[\w./\\-]+:\d+/;

/**
 * Did the closing message carry a findings block?
 *
 * "No findings" is a real answer — a review that read the change and found
 * nothing wrong must be able to say so. Anything else needs both a severity
 * and a `file:line`, the two parts a person can act on.
 *
 * @param {string|null|undefined} text
 */
export function hasFindings(text) {
  const said = String(text ?? '');
  return /no findings/i.test(said) || (SEVERITY.test(said) && ANCHOR.test(said));
}

/**
 * The task text a review run is given.
 *
 * @param {string} task what the person asked, verbatim
 * @param {{overlay?: any, base?: string|null}} [opts]
 * @returns {string}
 */
export function reviewBrief(task, { overlay = null, base = null } = {}) {
  const ask = String(task ?? '').trim() || 'Review this change.';
  const head = `Review run: read the change and report it. Nothing in this run can change the project — EDIT, CREATE, DELETE and MOVE are refused, and the shell is off.

For each finding write one line:
- major src/app.ts:42 — what is wrong — the smallest fix

Start with blocker, major or minor, then the path and the line. A change with nothing wrong is a real answer: write "no findings" and name what you read. Keep the list above the DONE.`;
  if (base) {
    const ref = String(base).trim();
    return `${head}\n\nReview the change against the git ref "${ref}" — run GIT diff ${ref}, then read around each hunk. The person asked: ${ask}`;
  }
  const changes = typeof overlay?.changes === 'function' ? overlay.changes() : [];
  if (!changes.length) {
    return `${head}\n\nNothing is staged in the overlay. Review the uncommitted working tree instead — run GIT diff, then read around each hunk. The person asked: ${ask}`;
  }
  let diff = changes
    .map((/** @type {any} */ c) => `--- ${c.file}${c.isNew ? ' (new file)' : c.deleted ? ' (deleted)' : ''}\n${c.diff}`)
    .join('\n');
  let clipped = false;
  if (diff.length > REVIEW_DIFF_CAP) {
    diff = diff.slice(0, REVIEW_DIFF_CAP);
    clipped = true;
  }
  return `${head}\n\nThe staged change under review (${changes.length} file(s)):\n\n${diff}${clipped ? `\n\n… the diff was cut at ${REVIEW_DIFF_CAP} characters — read the files for the rest.` : ''}\n\nThe person asked: ${ask}`;
}

export default reviewBrief;
