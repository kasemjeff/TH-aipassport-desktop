// Where the bridge records its pid.
//
// The bridge is a background process: the CLI starts it and walks away, the
// desktop backend starts it DETACHED so it outlives whatever started it. It
// is the only party that knows it is really the bridge on its port — a
// starter that LOST the race for the port has a pid and no port — so the
// BRIDGE writes this file, when it binds, and nobody else.
//
// That is the whole point of the file: it names the process that is actually
// answering, so `aipass stop` stops that one. A starter that wrote the file
// itself could leave it naming a process that died a moment later, and then
// `aipass stop` would stop nothing and the live bridge would stay.
//
// The file holds EVERY bridge of ours that is still running, one pid per
// line, not just the last one: two bridges on two ports are both real (the
// desktop's backend, and a suite's bridge on a port of its own), and a file
// that named only the newest would leave the other unreachable.
//
// The path is `~/.aipass/bridge.pid` unless AIPASS_BRIDGE_PIDFILE names
// another one — which is what the test suite does. The suite's bridges are
// shared by every test file (there is one port, so there is one bridge), so
// the file has to be shared too, and it has to live somewhere the suite can
// reach at the end of the run to end it.
import path from 'node:path';
import fs from 'node:fs';
import { aipassHome } from './settings.mjs';

/** The environment variable that moves the pid file. */
export const BRIDGE_PID_ENV = 'AIPASS_BRIDGE_PIDFILE';

/**
 * The file the bridge records its pid in.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export const bridgePidFile = (env = process.env) =>
  env[BRIDGE_PID_ENV]?.trim() || path.join(aipassHome(), 'bridge.pid');

/**
 * The pids the file names.
 *
 * @param {string} [file]
 * @returns {number[]}
 */
export function readRecordedPids(file = bridgePidFile()) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

/**
 * Is that process still running?
 *
 * The answer is "is it gone", not "did the signal land": a pid that was
 * never ours, or one whose process has ended, is not running — and that is
 * the answer that matters when the file is being pruned.
 *
 * @param {number} pid
 * @returns {boolean}
 */
export function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Record this bridge in the pid file, keeping the bridges that are still up.
 *
 * The file is the only way anything reaches a bridge that was started by
 * something else, so it has to name every one of them — and only the ones
 * that are really there, or it turns into a list of pids that died days ago.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {number} [options.pid]
 * @returns {string} the file that was written
 */
export function recordBridgePid({ env = process.env, pid = process.pid } = {}) {
  const file = bridgePidFile(env);
  const alive = readRecordedPids(file).filter((other) => other !== pid && isRunning(other));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [...alive, pid].join('\n') + '\n');
  return file;
}

/**
 * Drop this bridge from the pid file — and only this one.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {number} [options.pid]
 */
export function forgetBridgePid({ env = process.env, pid = process.pid } = {}) {
  const file = bridgePidFile(env);
  const rest = readRecordedPids(file).filter((other) => other !== pid);
  try {
    if (rest.length) fs.writeFileSync(file, rest.join('\n') + '\n');
    else fs.rmSync(file, { force: true });
  } catch { /* already gone */ }
}

/**
 * End every bridge the pid file names, and drop the file.
 *
 * The file names our bridges and nothing else, so this is the whole of
 * "stop the bridge". The answer is the pids that were ended (empty when
 * there was nothing to end), not whether the kill said so: a bridge that is
 * already gone is the outcome that was wanted.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {(pid: number) => void} [options.kill]
 * @returns {number[]} the pids that were ended
 */
export function stopRecordedBridge({ env = process.env, kill = (pid) => process.kill(pid) } = {}) {
  const file = bridgePidFile(env);
  const pids = readRecordedPids(file);
  const ended = [];
  for (const pid of pids) {
    try {
      kill(pid);
      ended.push(pid);
    } catch { /* already gone */ }
  }
  try { fs.rmSync(file, { force: true }); } catch { /* best effort */ }
  return ended;
}
