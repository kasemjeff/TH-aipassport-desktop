// @ts-check
// The option sheet, clamped.
//
// The sheet itself comes from `settings.mjs` (`harnessOptions`), the same one
// the harness builds its options from: a key cannot be defaulted in one place
// and clamped in another, and the shipped numbers live in one file.
//
// It lives here rather than in `loop.mjs` so the run's context can read it
// without importing the loop that owns the context — the two would otherwise
// import each other.
import { DEFAULT_MAX_TOOL_CALLS, DEFAULT_MAX_WALL_CLOCK_MS, harnessOptions } from '../settings.mjs';

/**
 * Normalize the loose option sheet once, before a run touches state. Pure:
 * every clamp and default lives here, so the loop body reads typed values and
 * a test can pin the policy without a bridge, a tool set or a session.
 *
 * @param {Partial<import('../settings.mjs').HarnessOptions>} [options]
 */
export function normalizeOptions(options = {}) {
  const sheet = harnessOptions(options);
  // The step cap, or no cap at all: 0 (the shipped default) means the
  // run goes until it is DONE, a guard stops it, or a budget below is spent. A
  // positive number caps the run, and the last step says so (step_limit).
  const rawCap = Number(sheet.maxSteps ?? 0);
  const maxSteps = Number.isFinite(rawCap) && rawCap > 0 ? Math.floor(rawCap) : Infinity;
  // 0 on the wire means "no cap" — Infinity does not survive JSON, so events
  // carry the option as the surfaces know it.
  const maxStepsWire = Number.isFinite(maxSteps) ? maxSteps : 0;
  // Per-run budgets — the defaults are imported from the settings file so the
  // fallback and the shipped setting can never drift apart. A reply full of
  // markers used to execute every one of them, and a yolo RUN can hold one
  // step open for minutes; either budget spent stops the run with its own stop
  // reason in run_stats — the real bound once the step cap is off.
  const maxToolCalls = Number(sheet.maxToolCalls) > 0
    ? Math.floor(Number(sheet.maxToolCalls)) : DEFAULT_MAX_TOOL_CALLS;
  const maxWallClockMs = Number(sheet.maxWallClockMs) > 0
    ? Math.floor(Number(sheet.maxWallClockMs)) : DEFAULT_MAX_WALL_CLOCK_MS;
  // (credit cap) Optional ceiling on observed spend, in credits. 0 = no cap.
  // The check rides the bridge's cached quota (its own 30s TTL), so it bounds
  // a runaway run without turning into an upstream request per step.
  const maxCredits = Number(sheet.maxCredits) > 0 ? Number(sheet.maxCredits) : 0;
  const model = sheet.model ?? null;
  // How hard the model thinks before each reply. 'off' (or nothing) means the
  // request never asks; the level that does go out is checked by the bridge
  // against the model, so a level it lacks never breaks a run.
  const thinking = sheet.thinking && String(sheet.thinking).toLowerCase() !== 'off'
    ? String(sheet.thinking).toLowerCase() : null;
  // Sampling temperature: a number 0..2 rides every send; anything else (the
  // null default included) never asks, so the server's own default stands.
  const temperature = typeof sheet.temperature === 'number' && Number.isFinite(sheet.temperature)
    ? Math.min(2, Math.max(0, sheet.temperature)) : null;
  const useSlim = Boolean(sheet.slim);
  const seedText = sheet.seedText ?? null;
  const pluginTools = sheet.pluginTools ?? [];
  // What plugins contributed to the turn-1 message, and the machine's own
  // helper roles. Both ride the sheet so the run reads one object; neither
  // is a number to clamp, only a list to carry.
  const pluginSections = Array.isArray(sheet.pluginSections) ? sheet.pluginSections : [];
  const helperPresets = sheet.helperPresets && typeof sheet.helperPresets === 'object' ? sheet.helperPresets : {};
  // (Thai pack) Language policy. `replyLanguage` is what the preamble tells
  // the model; `langCheck` is the stop hook that measures it — the closing
  // message's share of Thai letters (code and URLs excluded) must reach
  // `minThaiRatio`, or the run rewrites it once. Tool vocabulary stays
  // English regardless; that separation is the whole point.
  const replyLanguage = sheet.replyLanguage === 'en' ? 'en' : 'th';
  const langCheck = Boolean(sheet.langCheck);
  const minThaiRatio = Number.isFinite(Number(sheet.minThaiRatio))
    ? Math.min(1, Math.max(0, Number(sheet.minThaiRatio))) : 0.4;
  // (Thai pack) The pre-tool guard. repeatGuard refuses an identical call
  // (same kind, argument and body) already made twice with nothing staged in
  // between — a loop, not a step; repeatGuardMax is how many such refusals
  // one run may collect before it is stopped as stalled.
  const repeatGuard = Boolean(sheet.repeatGuard);
  const repeatGuardMax = Number(sheet.repeatGuardMax) > 0 ? Math.floor(Number(sheet.repeatGuardMax)) : 4;
  return {
    maxSteps, maxStepsWire, maxToolCalls, maxWallClockMs, maxCredits,
    model, thinking, temperature, useSlim, seedText, pluginTools,
    pluginSections, helperPresets,
    replyLanguage, langCheck, minThaiRatio, repeatGuard, repeatGuardMax,
  };
}

export default normalizeOptions;
