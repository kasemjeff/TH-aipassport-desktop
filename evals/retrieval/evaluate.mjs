// Shared scoring for the retrieval benchmark: the test asserts on it and the
// bench script prints it, so the two can never disagree about a number.
import { retrieve } from '../../aipass-bridge/harness/retrieval.mjs';

/**
 * Run one query set. `requireAll` is for the exact set: a multi-file answer
 * only counts when every expected path is in the top eight. The paraphrase set
 * reports any-match recall instead, because a lexical miss is the measurement,
 * not a test failure.
 */
export async function evaluate(dir, queries, { requireAll = false, limit = 8, budgetChars = 20000, overlay = null } = {}) {
  let recallHits = 0;
  let allHits = 0;
  let anyHits = 0;
  let mrrSum = 0;
  const misses = [];
  for (const q of queries) {
    const res = await retrieve(q.q, { root: dir, limit, budgetChars, overlay });
    const paths = res.hits.map((h) => h.path);
    const any = q.expect.some((p) => paths.includes(p));
    const all = q.expect.every((p) => paths.includes(p));
    let rr = 0;
    for (let i = 0; i < paths.length; i++) {
      if (q.expect.includes(paths[i])) { rr = 1 / (i + 1); break; }
    }
    if (any) anyHits++;
    if (all) allHits++;
    if (requireAll ? all : any) recallHits++;
    else misses.push({ q: q.q, expect: q.expect, got: paths.slice(0, 5) });
    mrrSum += rr;
  }
  return {
    total: queries.length,
    recall: recallHits / queries.length,
    allRecall: allHits / queries.length,
    anyRecall: anyHits / queries.length,
    mrr: mrrSum / queries.length,
    misses,
  };
}
