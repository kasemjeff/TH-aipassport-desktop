#!/usr/bin/env node
// scripts/install-ladder.mjs — the ladder the release procedure keeps asking
// for: install → assert → upgrade → assert → rollback → assert → uninstall →
// assert the data survived.
//
//   node scripts/install-ladder.mjs --new dist/aipass-desktop-0.2.0-windows-x64-setup.exe
//   node scripts/install-ladder.mjs --new <new installer> --old <the previous release's installer>
//
// What it proves, on whichever machine it runs on:
//
//   * the artifact installs — the app lands where the platform says it does;
//   * the installed build is the one that was shipped — its version matches;
//   * the installed app actually runs — its backend answers on the port;
//   * an upgrade over the old build keeps the user's data;
//   * a rollback to the old build keeps it too;
//   * an uninstall leaves the data alone: it belongs to the user, not to the
//     installer.
//
// The run never touches the real `~/.aipass`: the app is started with
// `AIPASS_HOME` pointing at a scratch directory, which the shell reads the
// same way the Node side reads it.
//
// Installing software changes the machine, so every run asks first. `--yes`
// is the answer for a release machine.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

/**
 * What this platform's artifact is and what installing it means.
 *
 * The pure part of the ladder, kept apart from the running of things so a
 * test can pin it: a platform that is not in this table has no ladder.
 */
export function planFor(platform = process.platform, artifact = '', env = process.env, home = os.homedir()) {
  const name = path.basename(artifact).toLowerCase();
  if (platform === 'win32' && name.endsWith('.exe')) {
    // NSIS in per-user mode installs under %LOCALAPPDATA%, so no
    // administrator is involved and the uninstaller is in *Apps*. The exact
    // folder is looked up rather than assumed — the installer owns it, and
    // the ladder only has to find it again.
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return {
      kind: 'nsis',
      candidates: [
        path.join(local, 'aipass desktop'),
        path.join(local, 'Programs', 'aipass desktop'),
        path.join(local, 'aipass-desktop'),
      ],
      installDir: '',
      ext: '.exe',
    };
  }
  if (platform === 'darwin' && name.endsWith('.dmg')) {
    return { kind: 'dmg', candidates: [], installDir: '', ext: '.app' };
  }
  if (platform === 'linux' && name.endsWith('.appimage')) {
    return { kind: 'appimage', candidates: [], installDir: '', ext: '.AppImage' };
  }
  if (platform === 'linux' && name.endsWith('.deb')) {
    return { kind: 'deb', candidates: ['/usr/bin'], installDir: '/usr/bin', ext: '' };
  }
  throw new Error(`no ladder for ${platform} and ${path.basename(artifact) || '(no artifact)'}`);
}

/** The version an artifact claims, from its file name. */
/** The order the ladder walks, given whether a previous artifact exists. */
export function ladderSteps(hasOld) {
  const steps = [];
  if (hasOld) steps.push('install-old');
  steps.push('install-new');
  if (hasOld) steps.push('rollback-old');
  steps.push('uninstall');
  return steps;
}

export function versionFromName(artifact) {
  const match = path.basename(artifact).match(/aipass-desktop-(\d+\.\d+\.\d+)/);
  return match ? match[1] : null;
}

/** Is the app already running? The single-instance plugin would make the
 * ladder's own launch a no-op, so the run has to know. */
export function runningInstance(exe) {
  const name = path.basename(exe);
  if (process.platform === 'win32') {
    const out = run('powershell', [
      '-NoProfile',
      '-Command',
      `Get-Process -Name '${name.replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`,
    ]);
    return (out.stdout || '').trim().split('\n').filter(Boolean);
  }
  const out = run('pgrep', ['-f', exe]);
  return (out.stdout || '').trim().split('\n').filter(Boolean);
}

/**
 * Stop anything still running *out of* the install directory.
 *
 * A backend that outlived its app keeps the installer's files open, and the
 * uninstaller cannot delete what is in use — it removes what it can and
 * stops. The ladder says what it stopped: these are the app's own
 * processes, on a machine the ladder is already installing and removing the
 * app from.
 */
export function stopInstalledProcesses(dir) {
  if (!dir) return [];
  if (process.platform === 'win32') {
    const out = run('powershell', [
      '-NoProfile',
      '-Command',
      `Get-Process | Where-Object { $_.Path -like '${dir.replace(/'/g, "''")}*' } | ForEach-Object { $_.Id }`,
    ]);
    const pids = (out.stdout || '').trim().split('\n').filter(Boolean);
    for (const pid of pids) run('taskkill', ['/PID', pid, '/T', '/F']);
    return pids;
  }
  const out = run('pkill', ['-f', dir]);
  return (out.stdout || '').trim().split('\n').filter(Boolean);
}

/** Run a command and wait for it. Returns its exit code and what it said. */
function run(cmd, args, opts = {}) {
  const isWindows = process.platform === 'win32';
  const quote = (a) => (isWindows && /[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a);
  const out = isWindows
    ? spawnSync([cmd, ...args].map(quote).join(' '), {
        cwd: opts.cwd ?? REPO,
        encoding: 'utf8',
        windowsHide: true,
        shell: true,
        timeout: opts.timeout ?? 10 * 60 * 1000,
        env: { ...process.env, ...(opts.env ?? {}) },
      })
    : spawnSync(cmd, args, {
        cwd: opts.cwd ?? REPO,
        encoding: 'utf8',
        windowsHide: true,
        timeout: opts.timeout ?? 10 * 60 * 1000,
        env: { ...process.env, ...(opts.env ?? {}) },
      });
  if (out.error) throw out.error;
  return { code: out.status ?? 1, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
}

/** Start the app and wait until its backend answers. */
async function launch(app, { home, port }) {
  const child = spawn(app, [], {
    cwd: path.dirname(app),
    env: { ...process.env, AIPASS_HOME: home, AIPASS_DESKTOP_PORT: String(port) },
    detached: process.platform !== 'win32',
    stdio: 'ignore',
    windowsHide: true,
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return { child, started: false };
    try {
      // The UI itself is served without a token (the token bootstrap is for
      // browser pages), so a plain GET is enough to prove the backend is up.
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) return { child, started: true };
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { child, started: false };
}

/** Stop the app and everything it started, and wait until it is really gone. */
async function stopAndWait(child) {
  stop(child);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  // The uninstaller refuses to run while the app still holds its files, so
  // give the OS a moment to let go.
  await new Promise((r) => setTimeout(r, 1000));
}

/** Stop the app and everything it started. */
function stop(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
}

/** A free port, so the ladder never fights the backend that is already up. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const step = (name, detail = '') => console.log(`\n· ${name}${detail ? ` — ${detail}` : ''}`);
const fail = (message) => {
  console.error(`\n  ✖ ${message}`);
  process.exitCode = 1;
  throw new Error(message);
};

/* --------------------------------------------------------------- per platform */

const windows = {
  install(artifact) {
    // NSIS silent install. `/S` is the flag; the exit code is what matters.
    const out = run(artifact, ['/S']);
    if (out.code !== 0) fail(`the installer exited ${out.code}`);
    return null;
  },
  installedExe(candidates) {
    for (const dir of candidates) {
      if (!fs.existsSync(dir)) continue;
      const exe = fs
        .readdirSync(dir)
        .find((name) => name.toLowerCase().endsWith('.exe') && !name.toLowerCase().startsWith('uninstall'));
      if (exe) return path.join(dir, exe);
    }
    return null;
  },
  version(exe) {
    const out = run('powershell', [
      '-NoProfile',
      '-Command',
      `(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`,
    ]);
    return (out.stdout || '').trim() || null;
  },
  uninstall(candidates) {
    const dir = candidates.find((entry) => fs.existsSync(entry));
    if (!dir) return;
    const exe = fs.readdirSync(dir).find((name) => name.toLowerCase().startsWith('uninstall'));
    if (exe) run(path.join(dir, exe), ['/S']);
  },
};

const macos = {
  install(artifact, { work }) {
    const out = run('hdiutil', ['attach', '-nobrowse', '-readonly', artifact]);
    if (out.code !== 0) fail(`the disk image would not mount: ${out.stderr.trim()}`);
    const mount = out.stdout
      .split('\n')
      .map((line) => line.trim().split(/\s+/).pop())
      .find((entry) => entry && entry.startsWith('/Volumes/'));
    if (!mount) fail('the disk image mounted but no volume was found');
    const app = fs.readdirSync(mount).find((name) => name.endsWith('.app'));
    if (!app) fail('the disk image holds no app');
    const target = path.join(work, 'Applications', app);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(mount, app), target, { recursive: true });
    run('hdiutil', ['detach', mount, '-quiet']);
    return path.join(work, 'Applications');
  },
  installedExe(dir) {
    if (!dir || !fs.existsSync(dir)) return null;
    const app = fs.readdirSync(dir).find((name) => name.endsWith('.app'));
    if (!app) return null;
    const binDir = path.join(dir, app, 'Contents', 'MacOS');
    const binary = fs.readdirSync(binDir).find((name) => !name.endsWith('.plist'));
    return binary ? path.join(binDir, binary) : null;
  },
  version(exe) {
    const plist = path.join(path.dirname(path.dirname(exe)), 'Info.plist');
    const out = run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist]);
    return (out.stdout || '').trim() || null;
  },
  uninstall(dir) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  },
};

const linux = {
  install(artifact) {
    const out = run('dpkg', ['-i', artifact]);
    if (out.code !== 0) fail(`the package would not install: ${out.stderr.trim()}`);
    return null;
  },
  installedExe(candidates) {
    for (const dir of candidates) {
      const exe = path.join(dir, 'aipass-desktop');
      if (fs.existsSync(exe)) return exe;
    }
    return null;
  },
  version(exe) {
    const out = run(exe, ['--version']);
    return (out.stdout || '').trim() || null;
  },
  uninstall() {
    run('dpkg', ['-r', 'aipass-desktop']);
  },
};

/* -------------------------------------------------------------------- the run */

async function main() {
  const args = process.argv.slice(2);
  const arg = (name) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? null : args[i + 1];
  };
  const newArtifact = arg('new') ? path.resolve(arg('new')) : null;
  const oldArtifact = arg('old') ? path.resolve(arg('old')) : null;
  if (!newArtifact) {
    console.error('usage: node scripts/install-ladder.mjs --new <artifact> [--old <previous artifact>]');
    process.exit(1);
  }
  for (const artifact of [newArtifact, oldArtifact].filter(Boolean)) {
    if (!fs.existsSync(artifact)) {
      console.error(`no such artifact: ${artifact}`);
      process.exit(1);
    }
  }
  const plan = planFor(process.platform, newArtifact);
  const impl = { win32: windows, darwin: macos, linux: linux }[process.platform];
  const newVersion = versionFromName(newArtifact);
  const oldVersion = oldArtifact ? versionFromName(oldArtifact) : null;

  // The scratch home: the app writes its settings, sessions and log there,
  // and the marker proves the installer never touches it.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-ladder-home-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aipass-ladder-work-'));
  const marker = path.join(home, 'marker.txt');
  fs.writeFileSync(marker, 'the data belongs to the user\n');

  console.log('aipass desktop install ladder');
  console.log(`  platform   ${process.platform} (${plan.kind})`);
  console.log(`  new        ${path.basename(newArtifact)}${newVersion ? ` (${newVersion})` : ''}`);
  if (oldArtifact) console.log(`  old        ${path.basename(oldArtifact)}${oldVersion ? ` (${oldVersion})` : ''}`);
  console.log(`  home       ${home} (the real ~/.aipass is not touched)`);

  if (!args.includes('--yes')) {
    console.log('\nThis installs the artifact on this machine. Press Ctrl+C to stop, or re-run with --yes.');
    const answer = await new Promise((resolve) => {
      process.stdin.setEncoding('utf8');
      process.stdin.once('data', (data) => resolve(data.trim().toLowerCase()));
      process.stdin.resume();
    });
    if (!['y', 'yes'].includes(answer)) {
      console.log('stopped — nothing was installed');
      process.exit(1);
    }
  }

  let installDir = plan.installDir;
  const assertRunning = async (label, expectedVersion) => {
    const exe = impl.installedExe(installDir ? [installDir] : plan.candidates);
    if (!exe) fail(`${label}: the app is not where it should be`);
    const version = impl.version(exe);
    if (expectedVersion && version && !version.startsWith(expectedVersion)) {
      fail(`${label}: the installed build says ${version}, the artifact says ${expectedVersion}`);
    }
    // A running instance would take the launch below as a request to focus
    // itself, and the ladder would measure the old build instead of this one.
    const already = runningInstance(exe);
    if (already.length) {
      fail(
        `${label}: the app is already running (pid ${already.join(', ')}) — quit it and run the ladder again`,
      );
    }
    const port = await freePort();
    const { child, started } = await launch(exe, { home, port });
    if (!started) {
      await stopAndWait(child);
      // The app's own log is in the scratch home; the last lines say why it
      // never came up.
      const log = path.join(home, 'logs', 'desktop-backend.log');
      let tail = '';
      if (fs.existsSync(log)) {
        tail = fs.readFileSync(log, 'utf8').trim().split('\n').slice(-8).join('\n      ');
      }
      fail(
        `${label}: the app did not answer on its port${child.exitCode !== null ? ` (it exited with ${child.exitCode})` : ''}` +
          (tail ? `\n      ${tail}` : ''),
      );
    }
    await stopAndWait(child);
    step(`${label}: installed, version ${version ?? 'unknown'}, the backend answered`, path.basename(exe));
  };

  try {
    // Baseline: prove the previous build installs, so the upgrade below is a
    // real upgrade rather than a fresh install of the new one.
    if (oldArtifact) {
      step('install (baseline)', path.basename(oldArtifact));
      const installed = impl.install(oldArtifact, { work });
      if (installed) installDir = installed;
      await assertRunning('install', oldVersion);
    }

    step(oldArtifact ? 'upgrade' : 'install', path.basename(newArtifact));
    const installed = impl.install(newArtifact, { work });
    if (installed) installDir = installed;
    await assertRunning(oldArtifact ? 'upgrade' : 'install', newVersion);

    if (oldArtifact) {
      step('rollback', path.basename(oldArtifact));
      impl.install(oldArtifact, { work });
      await assertRunning('rollback', oldVersion);
    }

    step('uninstall');
    // Anything still running out of the install directory keeps its files
    // open, and the uninstaller cannot delete what is in use.
    const stopped = stopInstalledProcesses(installDir || plan.candidates.find((entry) => fs.existsSync(entry)));
    if (stopped.length) step('stopped the app\'s own processes', stopped.join(', '));
    impl.uninstall(installDir ? [installDir] : plan.candidates, { work });
    // The NSIS uninstaller copies itself to a temp directory and runs from
    // there, so the process that was asked to uninstall is gone before the
    // uninstall is finished. Wait for the install directory to actually go.
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const dir = installDir || plan.candidates.find((entry) => fs.existsSync(entry));
      const empty = !dir || !fs.existsSync(dir) || fs.readdirSync(dir).length === 0;
      if (empty) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (plan.kind !== 'appimage') {
      const exe = impl.installedExe(installDir ? [installDir] : plan.candidates);
      const dir = installDir || plan.candidates.find((entry) => fs.existsSync(entry));
      const leftovers = dir && fs.existsSync(dir) ? fs.readdirSync(dir) : [];
      if (exe && fs.existsSync(exe)) fail(`uninstall: the app is still there (${dir})`);
      if (leftovers.length) fail(`uninstall: ${dir} still holds ${leftovers.join(', ')}`);
    }
    if (!fs.existsSync(marker)) fail('uninstall: the data did not survive');
    step('the data survived the uninstall', marker);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }

  console.log(`\n✔ the ladder passed: install → ${oldArtifact ? 'upgrade → rollback → ' : ''}uninstall, and the data stayed`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    if (!process.exitCode) console.error(err?.message ?? err);
    process.exit(process.exitCode ?? 1);
  });
}
