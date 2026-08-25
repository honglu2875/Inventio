/**
 * argv parsing for the fake `codex` CLI.
 *
 * Mirrors the surface of codex-cli 0.149.0 `codex exec`. Flags are parsed
 * correctly (so orchestrator flag drift is caught) but mostly ignored
 * semantically; only `-C`, `--json` and `--output-last-message`/`-o` change
 * what the simulator does.
 */

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Long flags that take no value. */
const BOOL_FLAGS = new Map([
  ['--json', 'json'],
  ['--ignore-user-config', 'ignoreUserConfig'],
  ['--skip-git-repo-check', 'skipGitRepoCheck'],
  ['--ephemeral', 'ephemeral'],
]);

/** Flags that take exactly one value. `repeat: true` => collected into an array. */
const VALUE_FLAGS = new Map([
  ['-C', { key: 'cd' }],
  ['-s', { key: 'sandbox' }],
  ['-m', { key: 'model' }],
  ['-p', { key: 'profile' }],
  ['-c', { key: 'config', repeat: true }],
  ['-i', { key: 'images', repeat: true }],
  ['-o', { key: 'outputLastMessage' }],
  ['--enable', { key: 'enable', repeat: true }],
  ['--disable', { key: 'disable', repeat: true }],
  ['--output-schema', { key: 'outputSchema' }],
  ['--output-last-message', { key: 'outputLastMessage' }],
  ['--color', { key: 'color' }],
]);

function emptyOptions() {
  return {
    /** always "exec" once parsing succeeds */
    command: null,
    /** THREAD_ID of `exec resume <THREAD_ID>`, else null */
    resumeOf: null,
    /** prompt text from argv, or null when it must come from stdin/is absent */
    prompt: null,
    /** true when the prompt was given as "-" */
    promptFromStdinArg: false,
    json: false,
    ignoreUserConfig: false,
    skipGitRepoCheck: false,
    ephemeral: false,
    cd: null,
    sandbox: null,
    model: null,
    profile: null,
    config: [],
    images: [],
    enable: [],
    disable: [],
    outputSchema: null,
    outputLastMessage: null,
    color: null,
  };
}

/**
 * @param {string[]} argv arguments after the executable (process.argv.slice(2))
 * @returns {ReturnType<typeof emptyOptions>}
 * @throws {UsageError}
 */
export function parseArgv(argv) {
  const opts = emptyOptions();

  if (argv.length === 0) {
    throw new UsageError('missing subcommand (expected "exec")');
  }
  if (argv[0] !== 'exec') {
    throw new UsageError(`unknown subcommand "${argv[0]}" (expected "exec")`);
  }
  opts.command = 'exec';

  let i = 1;
  if (argv[i] === 'resume') {
    const id = argv[i + 1];
    if (id === undefined || id === '-' || id.startsWith('-')) {
      throw new UsageError('"exec resume" requires a THREAD_ID');
    }
    opts.resumeOf = id;
    i += 2;
  }

  const positionals = [];
  const assign = (name, spec, value) => {
    if (spec.repeat) opts[spec.key].push(value);
    else opts[spec.key] = value;
  };

  while (i < argv.length) {
    const tok = argv[i];

    if (tok === '-') {
      positionals.push('-');
      i += 1;
      continue;
    }
    if (tok === '--') {
      for (i += 1; i < argv.length; i += 1) positionals.push(argv[i]);
      break;
    }

    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      const name = eq === -1 ? tok : tok.slice(0, eq);
      const attached = eq === -1 ? null : tok.slice(eq + 1);

      const boolKey = BOOL_FLAGS.get(name);
      if (boolKey) {
        if (attached !== null) throw new UsageError(`flag "${name}" does not take a value`);
        opts[boolKey] = true;
        i += 1;
        continue;
      }
      const spec = VALUE_FLAGS.get(name);
      if (spec) {
        let value = attached;
        if (value === null) {
          value = argv[i + 1];
          if (value === undefined) throw new UsageError(`flag "${name}" requires a value`);
          i += 1;
        }
        assign(name, spec, value);
        i += 1;
        continue;
      }
      throw new UsageError(`unknown flag "${name}"`);
    }

    if (tok.startsWith('-') && tok.length > 1) {
      const name = tok.slice(0, 2);
      let attached = tok.length > 2 ? tok.slice(2) : null;
      if (attached !== null && attached.startsWith('=')) attached = attached.slice(1);

      if (BOOL_FLAGS.has(name)) {
        // no short boolean flags exist today; keep the branch honest anyway
        throw new UsageError(`unknown flag "${name}"`);
      }
      const spec = VALUE_FLAGS.get(name);
      if (!spec) throw new UsageError(`unknown flag "${name}"`);

      let value = attached;
      if (value === null) {
        value = argv[i + 1];
        if (value === undefined) throw new UsageError(`flag "${name}" requires a value`);
        i += 1;
      }
      assign(name, spec, value);
      i += 1;
      continue;
    }

    positionals.push(tok);
    i += 1;
  }

  if (positionals.length > 1) {
    throw new UsageError(
      `unexpected extra positional argument "${positionals[1]}" (exec takes a single PROMPT)`,
    );
  }
  if (positionals.length === 1) {
    if (positionals[0] === '-') opts.promptFromStdinArg = true;
    else opts.prompt = positionals[0];
  }

  return opts;
}
