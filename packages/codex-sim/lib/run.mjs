/**
 * codex-sim main flow. See CONTRACT.md for the frozen semantics.
 */

import fs from 'node:fs';
import path from 'node:path';

import { parseArgv, UsageError } from './args.mjs';
import {
  SimError,
  appendCallLog,
  loadScenario,
  markConsumed,
  readConsumed,
  resolveStateDir,
  selectCall,
} from './scenario.mjs';

const USAGE_EXIT = 2;

/** stderr line, written synchronously so it survives process.exit(). */
function errLine(message) {
  try {
    fs.writeSync(2, `${message}\n`);
  } catch {
    /* stderr closed; nothing useful to do */
  }
}

function fail(message, code = USAGE_EXIT) {
  errLine(`codex-sim: ${message}`);
  process.exit(code);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One stdout line, one write(), flushed before we continue. */
function writeStdout(text) {
  return new Promise((resolve) => {
    process.stdout.write(text, () => resolve());
  });
}

async function readAllStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const USAGE_FIELDS = [
  'input_tokens',
  'cached_input_tokens',
  'cache_write_input_tokens',
  'output_tokens',
  'reasoning_output_tokens',
];

function normalizeUsage(usage) {
  const out = {};
  for (const field of USAGE_FIELDS) out[field] = 0;
  if (usage && typeof usage === 'object' && !Array.isArray(usage)) {
    Object.assign(out, usage);
  }
  return out;
}

function finalText(call) {
  const fm = call.finalMessage;
  if (fm === undefined) return '';
  if (typeof fm === 'string') return fm;
  return JSON.stringify(fm);
}

export async function main(argv = process.argv.slice(2)) {
  // 1. argv (unknown flags must fail before anything else happens).
  let opts;
  try {
    opts = parseArgv(argv);
  } catch (err) {
    if (err instanceof UsageError) fail(err.message);
    throw err;
  }

  const originalCwd = process.cwd();

  // 2. Environment. Relative paths in the env vars resolve against the cwd the
  //    process started in, so `-C` cannot move the scenario/state out from
  //    under us.
  const scenarioEnv = process.env.INVENTIO_SIM_SCENARIO;
  if (!scenarioEnv) fail('INVENTIO_SIM_SCENARIO is not set');
  const scenarioPath = path.resolve(originalCwd, scenarioEnv);
  const envStateDir = process.env.INVENTIO_SIM_STATE_DIR || null;

  // 3. -C: chdir before doing anything else observable.
  if (opts.cd !== null) {
    const target = path.resolve(originalCwd, opts.cd);
    try {
      process.chdir(target);
    } catch (err) {
      fail(`-C: cannot chdir to "${target}": ${err.code ?? err.message}`);
    }
  }

  // 4. SIGINT policy, installed before any output can be produced.
  const state = { stubborn: false };
  process.on('SIGINT', () => {
    if (!state.stubborn) process.exit(130);
  });

  // 5. Scenario + state dir.
  let scenario;
  let stateDir;
  let consumed;
  try {
    scenario = loadScenario(scenarioPath);
    stateDir = resolveStateDir({ scenarioPath, envStateDir, originalCwd });
    consumed = readConsumed(stateDir);
  } catch (err) {
    if (err instanceof SimError) fail(err.message);
    throw err;
  }

  // 6. Prompt: argv, or stdin for "-" / absent-with-piped-stdin.
  let prompt = opts.prompt ?? '';
  const wantsStdin = opts.promptFromStdinArg || (opts.prompt === null && !process.stdin.isTTY);
  if (wantsStdin && !process.stdin.isTTY) {
    prompt = await readAllStdin();
  }

  const cwd = process.cwd();

  // 7. Selection.
  const index = selectCall(scenario, consumed, { prompt, cwd, resumeOf: opts.resumeOf });

  // 8. Consume immediately (before emitting anything), then log the call.
  if (index >= 0) {
    try {
      markConsumed(stateDir, consumed, index);
    } catch (err) {
      fail(`cannot update consumed.json: ${err.code ?? err.message}`);
    }
  }
  try {
    appendCallLog(stateDir, {
      ts: new Date().toISOString(),
      index,
      argv,
      cwd,
      prompt,
      resumeOf: opts.resumeOf,
      taskToken: process.env.INVENTIO_TASK_TOKEN ?? null,
    });
  } catch (err) {
    fail(`cannot append calls.log.jsonl: ${err.code ?? err.message}`);
  }

  if (index < 0) {
    fail('no scenario call matches');
  }

  const call = scenario.calls[index];
  const behavior = call.behavior ?? 'ok';
  state.stubborn = call.stubbornSigint === true;
  const delayMs = Number.isFinite(call.delayMs) ? call.delayMs : 0;
  const threadId =
    opts.resumeOf ?? call.threadId ?? `sim-${String(index).padStart(4, '0')}`;
  const final = finalText(call);

  const emit = async (event) => {
    if (delayMs > 0) await sleep(delayMs);
    await writeStdout(`${JSON.stringify(event)}\n`);
  };

  if (behavior === 'exit-nonzero') {
    errLine('codex-sim: simulated failure');
    process.exit(Number.isInteger(call.exitCode) ? call.exitCode : 1);
  }

  const items = Array.isArray(call.items) ? call.items : [];

  if (opts.json) {
    await emit({ type: 'thread.started', thread_id: threadId });
    await emit({ type: 'turn.started' });
    for (const [n, entry] of items.entries()) {
      const item = { id: `item_${n}`, ...entry };
      item.id = `item_${n}`;
      await emit({ type: 'item.started', item });
      await emit({ type: 'item.completed', item });
    }
  }

  if (behavior === 'crash-mid-stream') {
    process.exit(Number.isInteger(call.exitCode) ? call.exitCode : 1);
  }

  if (behavior === 'hang') {
    setInterval(() => {}, 1000);
    return new Promise(() => {});
  }

  // behavior "ok" and "malformed-output" are identical here: the scenario
  // author decides whether `finalMessage` satisfies the orchestrator's schema.
  if (opts.json) {
    await emit({
      type: 'item.completed',
      item: { id: `item_${items.length}`, type: 'agent_message', text: final },
    });
  }

  if (opts.outputLastMessage !== null) {
    const target = path.resolve(cwd, opts.outputLastMessage);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, final);
    } catch (err) {
      fail(`cannot write --output-last-message "${target}": ${err.code ?? err.message}`);
    }
  }

  if (opts.json) {
    await emit({ type: 'turn.completed', usage: normalizeUsage(call.usage) });
  } else {
    if (delayMs > 0) await sleep(delayMs);
    await writeStdout(`${final}\n`);
  }

  process.exit(0);
}
