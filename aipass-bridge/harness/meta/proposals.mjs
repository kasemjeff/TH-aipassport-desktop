// A proposal: one change to one dimension, with the evidence behind it and a
// way back.
//
// AHE's rule is that a harness is edited one component at a time and the
// change is kept only when the score moves. That needs three things on disk:
// the candidate, the bytes it replaces (so a rollback is exact), and the
// evidence the optimizer cited (so a reader can check the reasoning without
// re-running anything).
//
// The arms are the other half. Evaluating a candidate means running the same
// matrix twice — once with the old document and once with the new one — and
// the two policy directories must differ in EXACTLY one file. If they differ
// in two, the comparison measures two changes at once and says nothing.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { aipassHome } from '../settings.mjs';
import { writeFileAtomic } from '../atomic-write.mjs';
import { DIMENSIONS } from './policy.mjs';

export const metaDir = (home = aipassHome()) => path.join(home, 'meta');
export const proposalsDir = (home = aipassHome()) => path.join(metaDir(home), 'proposals');
export const verdictsDir = (home = aipassHome()) => path.join(metaDir(home), 'verdicts');
export const armsDir = (home = aipassHome()) => path.join(metaDir(home), 'arms');

const writeJson = async (file, data) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(data, null, 2) + '\n');
};

const readJson = async (file) => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
};

/** A readable id: the minute, then three hex characters. */
export function newProposalId(now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 16);
  return `${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

/**
 * Record a candidate. The baseline is snapshotted HERE, at the moment the
 * candidate is written — not when it is applied — so a rollback restores the
 * bytes that were actually live when the change was proposed.
 */
export async function createProposal({
  home = aipassHome(),
  id = null,
  dimension,
  hypothesis = '',
  rationale = '',
  evidence = [],
  candidate = '',
  base = null,
  created = null,
} = {}) {
  if (!DIMENSIONS.includes(dimension)) throw new Error(`unknown dimension: ${dimension}`);
  const proposalId = id ?? newProposalId();
  const dir = path.join(proposalsDir(home), proposalId);
  await fs.mkdir(path.join(dir, 'candidate'), { recursive: true });
  await fs.mkdir(path.join(dir, 'baseline'), { recursive: true });
  await fs.writeFile(path.join(dir, 'candidate', `${dimension}.md`), candidate, 'utf8');
  if (typeof base === 'string') await fs.writeFile(path.join(dir, 'baseline', `${dimension}.md`), base, 'utf8');
  const record = {
    id: proposalId,
    dimension,
    hypothesis: String(hypothesis ?? ''),
    rationale: String(rationale ?? ''),
    evidence: Array.isArray(evidence) ? evidence : [],
    created: created ?? new Date().toISOString(),
    status: 'proposed',
    appliedAt: null,
    verdict: null,
  };
  await writeJson(path.join(dir, 'proposal.json'), record);
  return record;
}
export async function readProposal({ home = aipassHome(), id }) {
  const dir = path.join(proposalsDir(home), id);
  const record = await readJson(path.join(dir, 'proposal.json'));
  if (!record) return null;
  const candidate = await fs.readFile(path.join(dir, 'candidate', `${record.dimension}.md`), 'utf8').catch(() => null);
  const baseline = await fs.readFile(path.join(dir, 'baseline', `${record.dimension}.md`), 'utf8').catch(() => null);
  return { ...record, dir, candidate, baseline };
}

export async function listProposals({ home = aipassHome() } = {}) {
  let ids;
  try {
    ids = await fs.readdir(proposalsDir(home));
  } catch {
    return [];
  }
  const out = [];
  for (const id of ids.sort()) {
    const record = await readProposal({ home, id });
    if (record) out.push(record);
  }
  return out;
}

/** Every file in a policy directory, with its digest. */
async function policyFiles(dir) {
  const out = new Map();
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    if (!name.endsWith('.md')) continue;
    const bytes = await fs.readFile(path.join(dir, name)).catch(() => null);
    if (!bytes) continue;
    out.set(name, crypto.createHash('sha256').update(bytes).digest('hex').slice(0, 16));
  }
  return out;
}

/**
 * Build the two arm directories: the same policy, once with the baseline
 * document and once with the candidate. Only the one dimension's file
 * differs — that is the whole point of editing one component at a time, and
 * a difference anywhere else is a bug in the arm, not a finding.
 */
export async function buildArms({ home = aipassHome(), id, policyDir: liveDir }) {
  const proposal = await readProposal({ home, id });
  if (!proposal) throw new Error(`no proposal: ${id}`);
  const base = path.join(armsDir(home), id);
  const arms = {};
  for (const arm of ['baseline', 'candidate']) {
    const dir = path.join(base, arm);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    let names = [];
    try {
      names = await fs.readdir(liveDir);
    } catch { /* no live policy yet — the arm carries just this one file */ }
    for (const name of names) {
      if (!name.endsWith('.md')) continue;
      const bytes = await fs.readFile(path.join(liveDir, name)).catch(() => null);
      if (bytes) await fs.writeFile(path.join(dir, name), bytes);
    }
    const source = arm === 'baseline' ? proposal.baseline : proposal.candidate;
    if (typeof source === 'string') {
      await fs.writeFile(path.join(dir, `${proposal.dimension}.md`), source, 'utf8');
    } else if (arm === 'baseline') {
      // No baseline means the dimension had no document: the arm must not
      // carry one either, or the "one file differs" rule is a lie.
      await fs.rm(path.join(dir, `${proposal.dimension}.md`), { force: true });
    }
    arms[arm] = dir;
  }
  const a = await policyFiles(arms.baseline);
  const b = await policyFiles(arms.candidate);
  const changed = [];
  for (const name of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(name) !== b.get(name)) changed.push(name);
  }
  return { baselineDir: arms.baseline, candidateDir: arms.candidate, changed };
}

/** Put the candidate into the live policy directory. */
export async function applyProposal({ home = aipassHome(), id, policyDir: liveDir }) {
  const proposal = await readProposal({ home, id });
  if (!proposal) throw new Error(`no proposal: ${id}`);
  if (typeof proposal.candidate !== 'string') throw new Error(`proposal ${id} has no candidate document`);
  const file = path.join(liveDir, `${proposal.dimension}.md`);
  await fs.mkdir(liveDir, { recursive: true });
  writeFileAtomic(file, proposal.candidate);
  const record = { ...proposal, status: 'applied', appliedAt: new Date().toISOString() };
  await writeJson(path.join(proposal.dir, 'proposal.json'), {
    id: record.id, dimension: record.dimension, hypothesis: record.hypothesis, rationale: record.rationale,
    evidence: record.evidence, created: record.created, status: record.status, appliedAt: record.appliedAt, verdict: record.verdict,
  });
  return record;
}

/** Put the baseline back — the exact bytes, byte for byte. */
export async function rollbackProposal({ home = aipassHome(), id, policyDir: liveDir }) {
  const proposal = await readProposal({ home, id });
  if (!proposal) throw new Error(`no proposal: ${id}`);
  const file = path.join(liveDir, `${proposal.dimension}.md`);
  if (typeof proposal.baseline === 'string') {
    await fs.mkdir(liveDir, { recursive: true });
    writeFileAtomic(file, proposal.baseline);
  } else {
    await fs.rm(file, { force: true });
  }
  const record = { ...proposal, status: 'rolled-back' };
  await writeJson(path.join(proposal.dir, 'proposal.json'), {
    id: record.id, dimension: record.dimension, hypothesis: record.hypothesis, rationale: record.rationale,
    evidence: record.evidence, created: record.created, status: record.status, appliedAt: record.appliedAt, verdict: record.verdict,
  });
  return record;
}

/** The verdict of the last measurement of a proposal. */
export async function writeVerdict({ home = aipassHome(), id, verdict }) {
  const file = path.join(verdictsDir(home), `${id}.json`);
  await writeJson(file, { id, at: new Date().toISOString(), ...verdict });
  const proposal = await readProposal({ home, id });
  if (proposal) {
    const record = { ...proposal, status: proposal.status === 'proposed' ? 'measured' : proposal.status, verdict: verdict?.verdict ?? null };
    await writeJson(path.join(proposal.dir, 'proposal.json'), {
      id: record.id, dimension: record.dimension, hypothesis: record.hypothesis, rationale: record.rationale,
      evidence: record.evidence, created: record.created, status: record.status, appliedAt: record.appliedAt, verdict: record.verdict,
    });
  }
  return verdict;
}

export async function readVerdict({ home = aipassHome(), id }) {
  return readJson(path.join(verdictsDir(home), `${id}.json`));
}
