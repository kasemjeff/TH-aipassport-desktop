#!/usr/bin/env node
// aipass providers — the provider registry from the terminal.
//
// The desktop has the same list under /settings → ผู้ให้บริการ, and both
// read the same two files: ~/.aipass/providers.json (the specs) and
// ~/.aipass/credentials.json (the keys, owner-only). A provider added here is
// in the window on the next open, and one added there is here right now.
//
//   aipass providers                        list the providers
//   aipass providers add <id> [flags]      add or change one
//   aipass providers remove <id>           remove one (and its key)
//   aipass providers use <id>              make one the machine's default
//   aipass providers test <id>             ask it whether it answers
//   aipass providers path                  print where the files live
//
//   flags for add: --kind openai|anthropic --base-url URL --label TEXT
//                  --api-key-env ENV --model ID (repeatable) --key SECRET
import { ProviderStore, AIPASS_PROVIDER } from './harness/providers.mjs';
import { clientFor } from './harness/provider-client.mjs';
import { Settings } from './harness/settings.mjs';

const tty = Boolean(process.stdout.isTTY);
const dim = (s) => (tty ? `\x1b[2m${s}\x1b[0m` : String(s));
const green = (s) => (tty ? `\x1b[32m${s}\x1b[0m` : String(s));
const red = (s) => (tty ? `\x1b[31m${s}\x1b[0m` : String(s));

const store = new ProviderStore();
const settings = new Settings();
const [cmd, ...rest] = process.argv.slice(2);

/** `--flag value` and `--flag=value` both count; a flag may be repeated. */
function flags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const eq = arg.indexOf('=');
    if (eq > 0) {
      const key = arg.slice(2, eq);
      out[key] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const HELP = `aipass providers — ใครตอบรันรันนี้

  aipass providers                     list the providers
  aipass providers add <id> [flags]   add or change one
  aipass providers remove <id>        remove one (and its key)
  aipass providers use <id>           make one the machine's default
  aipass providers test <id>          ask it whether it answers
  aipass providers path                print where the files live

  flags for add:
    --kind openai|anthropic           the protocol (default: openai)
    --base-url URL                    https://api.openai.com/v1
    --label TEXT                      what the window shows
    --api-key-env ENV                 the env var that holds the key
    --model ID                        a model it offers (repeatable)
    --key SECRET                      the key itself (or leave it to the env var)

  The key is written to ~/.aipass/credentials.json with owner-only rights.
  A named env var wins over it, so the key never has to be written down.`;

function list() {
  const active = settings.get('defaultProvider') ?? AIPASS_PROVIDER;
  const rows = store.all();
  console.log(`${rows.length} provider(s):\n`);
  for (const p of rows) {
    const mark = p.id === active ? green('*') : ' ';
    const key = p.kind === 'aipass' ? 'no key needed' : (store.hasKey(p.id) ? 'key: yes' : red('key: no'));
    console.log(`${mark} ${p.id.padEnd(18)} ${p.kind.padEnd(10)} ${key}`);
    if (p.baseUrl) console.log(`  ${dim(p.baseUrl)}`);
    if (p.apiKeyEnv) console.log(`  ${dim(`key from $${p.apiKeyEnv}`)}`);
    if (p.models?.length) console.log(`  ${dim(`models: ${p.models.join(', ')}`)}`);
  }
  console.log(dim(`\n* = the provider a run uses now (${active})`));
}

function add(argv) {
  const f = flags(argv);
  const id = f._[0];
  if (!id) { console.error(red('a provider needs an id')); process.exit(1); }
  const existing = store.get(id);
  const spec = {
    id,
    label: f.label ?? existing?.label ?? id,
    kind: f.kind ?? existing?.kind ?? 'openai',
    baseUrl: f['base-url'] ?? existing?.baseUrl ?? '',
    apiKeyEnv: f['api-key-env'] ?? existing?.apiKeyEnv ?? '',
    models: f.model ? [].concat(f.model) : (existing?.models ?? []),
    defaultModel: existing?.defaultModel ?? null,
    headers: existing?.headers ?? {},
  };
  const saved = store.save(spec);
  if (typeof f.key === 'string' && f.key.trim()) store.setKey(saved.id, f.key);
  console.log(green(`saved the provider "${saved.id}"`) + dim(` — ${saved.baseUrl}`));
  if (typeof f.key === 'string' && f.key.trim()) console.log(dim('the key is in ~/.aipass/credentials.json (owner-only)'));
  else if (!saved.apiKeyEnv) console.log(dim(`no key yet — add one with: aipass providers add ${saved.id} --key <secret>`));
}

function remove(argv) {
  const id = argv[0];
  if (!id) { console.error(red('which provider?')); process.exit(1); }
  if (id === AIPASS_PROVIDER) { console.error(red('the aipass provider cannot be removed')); process.exit(1); }
  store.remove(id);
  if ((settings.get('defaultProvider') ?? AIPASS_PROVIDER) === id) {
    settings.set({ defaultProvider: AIPASS_PROVIDER });
    console.log(dim(`the provider in use was "${id}" — a run uses AiPASS again`));
  }
  console.log(green(`removed the provider "${id}"`));
}

function use(argv) {
  const id = argv[0];
  const spec = id ? store.get(id) : null;
  if (!spec) { console.error(red(`no provider "${id ?? ''}"`)); process.exit(1); }
  settings.set({ defaultProvider: spec.id });
  console.log(green(`a run now uses "${spec.id}"`));
}

async function test(argv) {
  const id = argv[0];
  const spec = id ? store.get(id) : null;
  if (!spec) { console.error(red(`no provider "${id ?? ''}"`)); process.exit(1); }
  if (spec.kind === 'aipass') {
    console.log('the aipass provider is the local bridge — run `aipass status` to check it');
    return;
  }
  const key = store.keyFor(spec.id);
  if (!key) {
    console.error(red(`no API key — set ${spec.apiKeyEnv ? `$${spec.apiKeyEnv}` : 'one with --key'}`));
    process.exit(1);
  }
  const client = clientFor(spec, { key, model: spec.defaultModel ?? null });
  const models = await client.models();
  if (models.source === 'live') {
    console.log(green(`ok — ${models.data.length} model(s)`));
    for (const m of models.data.slice(0, 12)) console.log(`  ${m.id}`);
    if (models.data.length > 12) console.log(dim(`  … ${models.data.length - 12} more`));
  } else {
    console.error(red(`not answering — ${models.error ?? 'no model list'}`));
    process.exit(1);
  }
}

switch (cmd) {
  case undefined:
  case 'list':
  case 'ls':
    list();
    break;
  case 'add':
    add(rest);
    break;
  case 'remove':
  case 'rm':
    remove(rest);
    break;
  case 'use':
    use(rest);
    break;
  case 'test':
    await test(rest);
    break;
  case 'path':
    console.log(store.file);
    console.log(store.credentialsFile);
    break;
  case 'help':
  case '--help':
  case '-h':
    console.log(HELP);
    break;
  default:
    console.error(red(`unknown command "${cmd}"`));
    console.error(HELP);
    process.exit(1);
}
