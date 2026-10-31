// @ts-check
// project-key.mjs — one project, one key.
//
// The retrieval index, the memory store, and the checkpoint store all key
// their files on the project's root. Using different hashes/algorithms for
// each one meant a project reached through a junction had two indices and
// lost its facts. This is the single implementation they all share: SHA-256
// over the REAL root (junctions collapse to one key), first 16 hex digits.
import path from 'node:path';
import crypto from 'node:crypto';
import { realPath } from './overlay.mjs';

/** @param {string} root */
export const projectKey = (root) => {
  const real = realPath(path.resolve(root)) ?? path.resolve(root);
  return crypto.createHash('sha256').update(real).digest('hex').slice(0, 16);
};
