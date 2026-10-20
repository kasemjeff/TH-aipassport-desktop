// Command-line parsing that knows which flags take a value.
//
// The naive reading — "a token that starts with -- is a flag, and the token
// after it is its value" — breaks the moment a flag takes no value: the task
// that follows it is eaten as the flag's value, and the run starts with no
// task at all. `npm run agent -- --apply "fix the bug"` printed the usage and
// exited; `npm run chat -- --new "what is X"` dropped the question and waited
// for a line that never came.
//
// So: a flag that takes a value takes the next token, unless that token is
// another flag; a flag that takes none is a switch, and the task after it is
// still the task.
//
// A flag given without a value keeps its default rather than handing back
// undefined, which used to crash the caller: path.resolve(undefined) for
// --root, undefined.replace for --bridge, and NaN for --max — the quiet one,
// because a NaN step limit means the loop never runs, so the agent printed
// its banner and exited having done nothing.
/**
 * Parse a command line, given the flags that take a value.
 *
 * @param {string[]} argv the arguments, without the node binary and the script
 * @param {Set<string>} valueFlags the flags that consume the next token
 * @returns {{
 *   values: Record<string, string | true>,
 *   positional: string[],
 *   flag: (name: string, fallback?: string | null) => string | null,
 *   has: (name: string) => boolean,
 * }}
 */
export function parseArgs(argv, valueFlags) {
  const values = Object.create(null);
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }

    // --name=value is the other spelling of the same thing.
    const eq = arg.indexOf('=');
    if (eq !== -1) { values[arg.slice(2, eq)] = arg.slice(eq + 1); continue; }

    const name = arg.slice(2);
    if (!valueFlags.has(name)) { values[name] = true; continue; }

    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) continue;
    values[name] = next;
    i++;
  }

  return {
    values,
    positional,
    // A flag's value, or the fallback when it was not given.
    flag: (name, fallback = null) => (values[name] === undefined ? fallback : values[name]),
    // A switch: true when it was given.
    has: (name) => values[name] === true,
  };
}
