// The agent guide is part of the product: any AI that opens this repo trusts
// it, and a stale anchor is a lie an agent will act on. agents-lint keeps the
// guide honest — Verify anchors must name real tests, shims must point at the
// canon, the files must stay inside their budgets. The same check runs
// standalone via `npm run agents:lint`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lint } from '../../scripts/agents-lint.mjs';

test('the agent guide resolves: anchors are real tests, shims point home', () => {
  const { anchors, titles, problems } = lint();
  assert.equal(
    problems.length,
    0,
    `agents-lint found problems:\n- ${problems.join('\n- ')}`
  );
  assert.ok(anchors >= 10, `the guide still carries Verify anchors (found ${anchors})`);
  assert.ok(titles > 100, `the test scan still finds titles (found ${titles})`);
});
