// The provider registry — one file of provider specs, one file of keys.
//
// AiPASS is the provider the app was built around and it stays the default:
// the bridge, the Chrome extension and the logged-in tab are still the path it
// takes. This file is what lets a person point the same app at another one —
// an OpenAI-compatible endpoint, an Anthropic key — without the bridge ever
// learning about it.
//
// Two files, on purpose:
//   providers.json    the specs: where the endpoint is, which protocol it
//                     speaks, which environment variable holds its key, which
//                     models it offers. Nothing secret.
//   credentials.json  the keys, owner-only (0600). A spec may name an
//                     environment variable instead, and that wins — so the key
//                     never has to touch the disk at all.
//
// Not settings.json: that file is shared by the window, the CLI and the
// backend, and its own header says no credential belongs in it. The provider
// specs are machine configuration, not preferences; the key is a secret.
import fs from 'node:fs';
import path from 'node:path';
import { aipassHome } from './settings.mjs';

/** The provider the app was built around: the local bridge and its tab. */
export const AIPASS_PROVIDER = 'aipass';

/** The protocols an added provider can speak. */
export const PROVIDER_KINDS = ['openai', 'anthropic'];

/**
 * The provider every install starts with. It is not in providers.json — it is
 * built in, because it is the one provider that needs no key, no endpoint and
 * no configuration at all.
 */
export const BUILTIN_PROVIDER = {
  id: AIPASS_PROVIDER,
  label: 'AiPASS (de.aipass.net)',
  kind: AIPASS_PROVIDER,
  baseUrl: '',
  apiKeyEnv: '',
  models: [],
  defaultModel: null,
  builtin: true,
};

/**
 * A provider id is also an environment-variable suffix and a credentials key,
 * so it is restricted to the characters both of those accept.
 */
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const ENV_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Normalise one provider spec, or say why it cannot be used.
 *
 * The rules are the ones a typo would break silently: an id that is not a
 * safe word could not be an environment variable or a file key, a base URL
 * that is not http(s) would send a key somewhere it must not go, and a
 * protocol nobody implements would produce a provider that fails on the first
 * send with no clue why.
 */
export function sanitizeSpec(raw = {}) {
  const id = String(raw.id ?? '').trim().toLowerCase();
  if (!ID_RE.test(id)) {
    throw new Error(`provider id "${raw.id ?? ''}" is not allowed — use letters, digits, . _ - only`);
  }
  if (id === AIPASS_PROVIDER) throw new Error('the aipass provider is built in and cannot be redefined');
  const kind = String(raw.kind ?? 'openai').trim().toLowerCase();
  if (!PROVIDER_KINDS.includes(kind)) {
    throw new Error(`unknown provider kind "${raw.kind}" — one of ${PROVIDER_KINDS.join(', ')}`);
  }
  const baseUrl = String(raw.baseUrl ?? '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(baseUrl)) {
    throw new Error('base url must start with http:// or https://');
  }
  const apiKeyEnv = String(raw.apiKeyEnv ?? '').trim();
  if (apiKeyEnv && !ENV_RE.test(apiKeyEnv)) {
    throw new Error(`"${apiKeyEnv}" is not a valid environment variable name`);
  }
  const models = Array.isArray(raw.models)
    ? [...new Set(raw.models.map((m) => String(m).trim()).filter(Boolean))].slice(0, 200)
    : [];
  const defaultModel = typeof raw.defaultModel === 'string' && raw.defaultModel.trim()
    ? raw.defaultModel.trim()
    : null;
  // Extra headers are a provider's own requirement (an org id, a project
  // header). Only string values: a header whose value is an object is a
  // mistake, not a feature.
  const headers = {};
  if (raw.headers && typeof raw.headers === 'object' && !Array.isArray(raw.headers)) {
    for (const [k, v] of Object.entries(raw.headers)) {
      const name = String(k).trim();
      if (!name) continue;
      headers[name] = String(v);
    }
  }
  const label = String(raw.label ?? id).trim().slice(0, 80) || id;
  return { id, label, kind, baseUrl, apiKeyEnv, models, defaultModel, headers };
}

/** A spec without the fields the UI never needs to see. */
export function publicSpec(spec) {
  return {
    id: spec.id,
    label: spec.label,
    kind: spec.kind,
    baseUrl: spec.baseUrl,
    apiKeyEnv: spec.apiKeyEnv,
    models: spec.models ?? [],
    defaultModel: spec.defaultModel ?? null,
    builtin: Boolean(spec.builtin),
  };
}

export class ProviderStore {
  /** @param {string} [dir] where the files live; defaults to `aipassHome()` */
  constructor(dir = aipassHome()) {
    this.dir = dir;
    this.file = path.join(dir, 'providers.json');
    this.credentialsFile = path.join(dir, 'credentials.json');
  }

  /** Every provider: the built-in one first, then the saved ones. */
  all() {
    return [BUILTIN_PROVIDER, ...this.saved()];
  }

  /**
   * The saved specs, read from disk every time — the file is the truth, and a
   * second copy in memory is a second copy that can go stale.
   *
   * A row that does not survive `sanitizeSpec` is dropped rather than fatal:
   * one broken line must not cost a person every provider they configured.
   */
  saved() {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return [];
    }
    const list = Array.isArray(parsed) ? parsed : (parsed?.providers ?? []);
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
      try { out.push(sanitizeSpec(raw)); } catch { /* a broken row is not a reason to lose the others */ }
    }
    return out;
  }

  get(id) {
    const want = String(id ?? '').trim().toLowerCase();
    return this.all().find((p) => p.id === want) ?? null;
  }

  /** Add or replace one provider. Returns the stored spec. */
  save(spec) {
    const clean = sanitizeSpec(spec);
    const rest = this.saved().filter((p) => p.id !== clean.id);
    rest.push(clean);
    this.#writeSpecs(rest);
    return clean;
  }

  /** Remove a provider and whatever key was filed under it. */
  remove(id) {
    const want = String(id ?? '').trim().toLowerCase();
    if (want === AIPASS_PROVIDER) throw new Error('the aipass provider cannot be removed');
    const rest = this.saved().filter((p) => p.id !== want);
    this.#writeSpecs(rest);
    const creds = this.#credentials();
    if (creds[want]) {
      delete creds[want];
      this.#writeCredentials(creds);
    }
    return rest.length !== this.saved().length;
  }

  /**
   * The key for a provider: the environment variable first, then the file.
   *
   * The environment wins so a person can put the key in their shell and never
   * have it written down at all — and so a CI run can carry it without a
   * file. The file is the fallback for the desktop, where there is no shell to
   * export into.
   */
  keyFor(id) {
    const spec = this.get(id);
    if (!spec) return null;
    if (spec.apiKeyEnv) {
      const fromEnv = String(process.env[spec.apiKeyEnv] ?? '').trim();
      if (fromEnv) return fromEnv;
    }
    const creds = this.#credentials();
    const stored = typeof creds[spec.id] === 'string' ? creds[spec.id].trim() : '';
    return stored || null;
  }

  /** Store (or clear, with an empty value) a provider's key. */
  setKey(id, key) {
    const want = String(id ?? '').trim().toLowerCase();
    if (want === AIPASS_PROVIDER) throw new Error('the aipass provider needs no key');
    if (!this.get(want)) throw new Error(`no provider "${want}"`);
    const creds = this.#credentials();
    const clean = String(key ?? '').trim();
    if (clean) creds[want] = clean; else delete creds[want];
    this.#writeCredentials(creds);
    return Boolean(clean);
  }

  /** Whether a provider has a key somewhere — never the key itself. */
  hasKey(id) {
    return Boolean(this.keyFor(id));
  }

  #credentials() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.credentialsFile, 'utf8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  #writeSpecs(list) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ providers: list }, null, 2) + '\n');
    fs.renameSync(tmp, this.file); // atomic: a crash mid-write never loses the list
  }

  /**
   * The keys, owner-only.
   *
   * The mode is set on the temporary file AND after the rename, because
   * `writeFileSync`'s `mode` only applies when it creates the file — a stale
   * .tmp from an earlier run would otherwise keep its old permissions.
   */
  #writeCredentials(creds) {
    fs.mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.credentialsFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(creds, null, 2) + '\n', { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch { /* windows has no POSIX modes */ }
    fs.renameSync(tmp, this.credentialsFile);
    try { fs.chmodSync(this.credentialsFile, 0o600); } catch { /* windows has no POSIX modes */ }
  }
}

export default ProviderStore;
