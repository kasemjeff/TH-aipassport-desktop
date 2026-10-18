// memory-store.mjs — cross-session memory for a project.
//
// The memory tier (compact.mjs) carries facts across rotations *within* a
// session. This module carries them across *sessions*: a small JSON file per
// project under ~/.aipass/memory/<project-hash>.json holds the durable facts,
// and a new session loads them into its first turn. Dedup and cap match the
// within-session tier (case/space-insensitive dedup, 200 chars/fact, 50 facts).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { aipassHome } from './settings.mjs';

const DIR = path.join(aipassHome(), 'memory');
const CAP = 50;
const FACT_CAP = 200;

function norm(f) { return String(f).toLowerCase().replace(/\s+/g, ' ').trim(); }

function mergeFacts(prev, fresh) {
  const out = [];
  const seen = new Set();
  for (const f of [...(prev || []), ...(fresh || [])]) {
    const s = String(f).trim().slice(0, FACT_CAP);
    if (!s) continue;
    const key = norm(s);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  while (out.length > CAP) out.shift();
  return out;
}

function projectHash(root) { return crypto.createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 12); }
function storePath(root) { try { fs.mkdirSync(DIR, { recursive: true }); } catch {} return path.join(DIR, projectHash(root) + '.json'); }

export function loadMemory(root) {
  try {
    const raw = fs.readFileSync(storePath(root), 'utf8');
    const data = JSON.parse(raw);
    const arr = Array.isArray(data) ? data : (data && Array.isArray(data.facts) ? data.facts : []);
    return arr.map((f) => String(f).trim().slice(0, FACT_CAP)).filter(Boolean).slice(0, CAP);
  } catch {}
  return [];
}

export function saveMemory(root, facts) {
  const merged = mergeFacts(loadMemory(root), facts).slice(0, CAP);
  try { fs.writeFileSync(storePath(root), JSON.stringify(merged, null, 2) + '\n'); } catch {}
  return merged;
}

export function clearMemory(root) {
  try { fs.rmSync(storePath(root), { force: true }); } catch {}
}

export function memoryPath(root) { return storePath(root); }
