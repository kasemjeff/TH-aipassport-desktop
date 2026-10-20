// The live half of the QA loop: what the backend says about itself, and
// whether that is a healthy answer.
//
// A backend that refuses the call is running and refusing. Reporting that
// as "ok" — with an undefined model and a zero percent context — turned a
// broken backend into a green line, which is the one thing a check like this
// must never do.
export function liveVerdict(body) {
  if (!body) return { state: 'warn', detail: 'not running — start it with `aipass desktop`' };
  if (body.ok !== true) return { state: 'warn', detail: `refused the call — ${body.error ?? 'no answer'}` };
  const ctx = body.result?.context ?? {};
  const compactAt = ctx.compactAt ?? 40;
  return {
    state: 'ok',
    detail: `model ${body.result?.model} · context ${ctx.percent ?? 0}% (rotates at ${compactAt}%) · ${body.result?.extensions ?? 0} extension(s)`,
    needsCompaction: ctx.needsCompaction === true,
  };
}
