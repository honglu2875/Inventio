import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const BIN = fileURLToPath(new URL('../bin/codex-sim.mjs', import.meta.url));
const FIXTURES = fileURLToPath(new URL('../fixtures/', import.meta.url));

/** temp dirs created by tests, removed afterwards */
const tmpDirs = [];

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

/**
 * Copy a fixture scenario into a fresh temp dir.
 * @param {string} fixture file name inside fixtures/
 * @param {{ownStateDir?: boolean, workdirName?: string}} [options]
 */
async function setup(fixture, options = {}) {
  const { ownStateDir = true, workdirName = 'work' } = options;
  const root = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-sim-')));
  tmpDirs.push(root);
  const scenarioPath = path.join(root, fixture);
  await fsp.copyFile(path.join(FIXTURES, fixture), scenarioPath);
  const stateDir = ownStateDir ? path.join(root, 'state') : null;
  const workdir = path.join(root, workdirName);
  await fsp.mkdir(workdir, { recursive: true });
  return { root, scenarioPath, stateDir, workdir };
}

/**
 * Spawn the real bin (relies on the shebang + exec bit).
 * @returns {{child: import('node:child_process').ChildProcess, done: Promise<{code:number|null,signal:string|null,stdout:string,stderr:string}>, snapshot: () => {stdout:string,stderr:string,closed:boolean}}}
 */
function launch(args, opts = {}) {
  const { scenarioPath, stateDir, cwd, input = '', taskToken, env: extraEnv } = opts;
  const env = { ...process.env };
  delete env.INVENTIO_SIM_SCENARIO;
  delete env.INVENTIO_SIM_STATE_DIR;
  delete env.INVENTIO_TASK_TOKEN;
  if (scenarioPath) env.INVENTIO_SIM_SCENARIO = scenarioPath;
  if (stateDir) env.INVENTIO_SIM_STATE_DIR = stateDir;
  if (taskToken) env.INVENTIO_TASK_TOKEN = taskToken;
  Object.assign(env, extraEnv ?? {});

  const child = spawn(BIN, args, {
    cwd: cwd ?? os.tmpdir(),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let closed = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    stdout += d;
  });
  child.stderr.on('data', (d) => {
    stderr += d;
  });
  if (input !== null) child.stdin.end(input);

  const done = new Promise((resolve) => {
    child.on('close', (code, signal) => {
      closed = true;
      resolve({ code, signal, stdout, stderr });
    });
  });

  return { child, done, snapshot: () => ({ stdout, stderr, closed }) };
}

/** Spawn and wait. */
function run(args, opts) {
  return launch(args, opts).done;
}

const events = (stdout) =>
  stdout
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));

async function readLog(stateDir) {
  const raw = await fsp.readFile(path.join(stateDir, 'calls.log.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

async function readConsumed(stateDir) {
  return JSON.parse(await fsp.readFile(path.join(stateDir, 'consumed.json'), 'utf8'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('happy path', () => {
  it('emits the full event sequence, writes the last message, and records state', async () => {
    // no explicit state dir: exercises the default "<scenario>.state/"
    const { scenarioPath, workdir } = await setup('happy.json', { ownStateDir: false });
    const prompt = 'Execute assignment.md in this directory.';
    const argv = [
      'exec',
      '--json',
      '--ignore-user-config',
      '--skip-git-repo-check',
      '-C',
      workdir,
      '-s',
      'read-only',
      '-m',
      'gpt-5-codex',
      '-c',
      'model_reasoning_effort="high"',
      '--output-schema',
      'role-output.schema.json',
      '--output-last-message',
      'out/last-message.json',
      prompt,
    ];

    const res = await run(argv, { scenarioPath, taskToken: 'tok-abc' });
    expect(res.stderr).toBe('');
    expect(res.code).toBe(0);

    const evs = events(res.stdout);
    expect(evs.map((e) => e.type)).toEqual([
      'thread.started',
      'turn.started',
      'item.started',
      'item.completed',
      'item.started',
      'item.completed',
      'item.completed',
      'turn.completed',
    ]);
    expect(evs[0]).toEqual({ type: 'thread.started', thread_id: 'sim-0001' });
    expect(evs[1]).toEqual({ type: 'turn.started' });
    expect(evs[2].item.id).toBe('item_0');
    expect(evs[2].item.type).toBe('reasoning');
    expect(evs[3].item).toEqual(evs[2].item);
    expect(evs[4].item).toEqual({
      id: 'item_1',
      type: 'command_execution',
      command: 'ls -la',
      aggregated_output: 'assignment.md\nAGENTS.md\n',
      exit_code: 0,
    });
    expect(evs[5].item).toEqual(evs[4].item);

    const scenario = JSON.parse(await fsp.readFile(scenarioPath, 'utf8'));
    const finalText = JSON.stringify(scenario.calls[0].finalMessage);
    expect(evs[6].item).toEqual({ id: 'item_2', type: 'agent_message', text: finalText });
    expect(evs[7]).toEqual({
      type: 'turn.completed',
      usage: {
        input_tokens: 1000,
        cached_input_tokens: 128,
        cache_write_input_tokens: 0,
        output_tokens: 200,
        reasoning_output_tokens: 50,
      },
    });

    // --output-last-message resolved against the cwd after -C
    const written = await fsp.readFile(path.join(workdir, 'out/last-message.json'), 'utf8');
    expect(written).toBe(finalText);
    expect(JSON.parse(written).conclusion).toBe('PROVED');

    const stateDir = `${scenarioPath}.state`;
    expect(await readConsumed(stateDir)).toEqual([0]);

    const log = await readLog(stateDir);
    expect(log).toHaveLength(1);
    expect(log[0].index).toBe(0);
    expect(log[0].argv).toEqual(argv);
    expect(log[0].cwd).toBe(workdir);
    expect(log[0].prompt).toBe(prompt);
    expect(log[0].resumeOf).toBe(null);
    expect(log[0].taskToken).toBe('tok-abc');
    expect(typeof log[0].ts).toBe('string');
    expect(Number.isNaN(Date.parse(log[0].ts))).toBe(false);
  });

  it('prints only the final message when --json is absent', async () => {
    const { scenarioPath, stateDir } = await setup('happy.json');
    const res = await run(['exec', 'Execute assignment.md in this directory.'], {
      scenarioPath,
      stateDir,
    });
    expect(res.code).toBe(0);
    expect(res.stdout.startsWith('{"conclusion":"PROVED"')).toBe(true);
    expect(res.stdout.endsWith('\n')).toBe(true);
    expect(res.stdout.includes('"type":"thread.started"')).toBe(false);
  });

  it('taskToken is null when INVENTIO_TASK_TOKEN is unset', async () => {
    const { scenarioPath, stateDir } = await setup('happy.json');
    await run(['exec', '--json', 'Execute assignment.md in this directory.'], {
      scenarioPath,
      stateDir,
    });
    const log = await readLog(stateDir);
    expect(log[0].taskToken).toBe(null);
  });

  it('malformed-output behaves exactly like ok', async () => {
    const { scenarioPath, stateDir, workdir } = await setup('malformed.json');
    const res = await run(
      [
        'exec',
        '--json',
        '-C',
        workdir,
        '--output-last-message',
        'last.txt',
        'Execute assignment.md in this directory.',
      ],
      { scenarioPath, stateDir },
    );
    expect(res.code).toBe(0);
    const evs = events(res.stdout);
    expect(evs.at(-1).type).toBe('turn.completed');
    const final = 'Sure! Here is my proof, but not in the schema you asked for.';
    expect(evs.at(-2).item).toEqual({ id: 'item_1', type: 'agent_message', text: final });
    expect(await fsp.readFile(path.join(workdir, 'last.txt'), 'utf8')).toBe(final);
  });

  it('matches on cwdContains after -C', async () => {
    const { scenarioPath, stateDir, root } = await setup('cwd.json');
    const packet = path.join(root, 'packet-T007');
    await fsp.mkdir(packet);

    const miss = await run(['exec', '--json', 'Execute assignment.md'], {
      scenarioPath,
      stateDir,
      cwd: root,
    });
    expect(miss.code).toBe(2);

    const hit = await run(['exec', '--json', '-C', packet, 'Execute assignment.md'], {
      scenarioPath,
      stateDir,
      cwd: root,
    });
    expect(hit.code).toBe(0);
    expect(events(hit.stdout)[0].thread_id).toBe('sim-cwd-1');
    const log = await readLog(stateDir);
    expect(log.map((r) => r.index)).toEqual([-1, 0]);
    expect(log[1].cwd).toBe(packet);
  });

  it('delayMs delays every emitted line', async () => {
    const { scenarioPath, stateDir } = await setup('delay.json');
    const started = Date.now();
    const res = await run(['exec', '--json', 'anything'], { scenarioPath, stateDir });
    const elapsed = Date.now() - started;
    expect(res.code).toBe(0);
    // 6 lines x 40ms
    expect(events(res.stdout)).toHaveLength(6);
    expect(elapsed).toBeGreaterThanOrEqual(200);
  });
});

describe('call selection', () => {
  it('consumes calls in order across sequential invocations', async () => {
    const { scenarioPath, stateDir } = await setup('sequence.json');

    const first = await run(['exec', '--json', 'one'], { scenarioPath, stateDir });
    expect(first.code).toBe(0);
    expect(events(first.stdout)[0].thread_id).toBe('sim-0001');
    expect(await readConsumed(stateDir)).toEqual([0]);

    const second = await run(['exec', '--json', 'two'], { scenarioPath, stateDir });
    expect(second.code).toBe(0);
    const secondEvents = events(second.stdout);
    expect(secondEvents[0].thread_id).toBe('sim-0002');
    expect(secondEvents.at(-2).item).toEqual({
      id: 'item_0',
      type: 'agent_message',
      text: 'second',
    });
    expect(await readConsumed(stateDir)).toEqual([0, 1]);

    const third = await run(['exec', '--json', 'three'], { scenarioPath, stateDir });
    expect(third.code).toBe(2);
    expect(third.stderr.trim()).toBe('codex-sim: no scenario call matches');
    expect(third.stdout).toBe('');

    const log = await readLog(stateDir);
    expect(log.map((r) => r.index)).toEqual([0, 1, -1]);
    expect(log.map((r) => r.prompt)).toEqual(['one', 'two', 'three']);
    expect(await readConsumed(stateDir)).toEqual([0, 1]);
  });

  it('no match exits 2 and still logs index -1', async () => {
    const { scenarioPath, stateDir } = await setup('happy.json');
    const res = await run(['exec', '--json', 'unrelated prompt'], { scenarioPath, stateDir });
    expect(res.code).toBe(2);
    expect(res.stderr.trim()).toBe('codex-sim: no scenario call matches');
    const log = await readLog(stateDir);
    expect(log).toHaveLength(1);
    expect(log[0].index).toBe(-1);
    expect(fs.existsSync(path.join(stateDir, 'consumed.json'))).toBe(false);
  });

  it('resume selects only resumeOf calls and reuses the thread id', async () => {
    const { scenarioPath, stateDir } = await setup('resume.json');

    // a non-resume invocation must not select the call declaring resumeOf
    const wrongKind = await run(['exec', '--json', 'again please'], { scenarioPath, stateDir });
    expect(wrongKind.code).toBe(2);
    expect(wrongKind.stderr.trim()).toBe('codex-sim: no scenario call matches');

    const first = await run(['exec', '--json', 'start here'], { scenarioPath, stateDir });
    expect(first.code).toBe(0);
    expect(events(first.stdout)[0].thread_id).toBe('sim-thread-7');

    // resume with the wrong thread id matches nothing
    const wrongId = await run(['exec', 'resume', 'sim-thread-9', '--json', 'again please'], {
      scenarioPath,
      stateDir,
    });
    expect(wrongId.code).toBe(2);

    const resumed = await run(['exec', 'resume', 'sim-thread-7', '--json', 'again please'], {
      scenarioPath,
      stateDir,
    });
    expect(resumed.code).toBe(0);
    const evs = events(resumed.stdout);
    // thread.started echoes the resumed id, not the call's threadId field
    expect(evs[0]).toEqual({ type: 'thread.started', thread_id: 'sim-thread-7' });
    expect(evs.at(-2).item.text).toBe('{"conclusion":"PROVED"}');
    expect(await readConsumed(stateDir)).toEqual([0, 1]);

    const log = await readLog(stateDir);
    expect(log.map((r) => r.index)).toEqual([-1, 0, -1, 1]);
    expect(log.map((r) => r.resumeOf)).toEqual([null, null, 'sim-thread-9', 'sim-thread-7']);
  });
});

describe('failure injection', () => {
  it('crash-mid-stream stops before turn.completed and exits nonzero', async () => {
    const { scenarioPath, stateDir, workdir } = await setup('crash.json');
    const res = await run(
      ['exec', '--json', '-C', workdir, '--output-last-message', 'last.txt', 'go'],
      { scenarioPath, stateDir },
    );
    expect(res.code).toBe(3);
    const types = events(res.stdout).map((e) => e.type);
    expect(types).toEqual([
      'thread.started',
      'turn.started',
      'item.started',
      'item.completed',
      'item.started',
      'item.completed',
    ]);
    expect(types).not.toContain('turn.completed');
    expect(res.stdout).not.toContain('agent_message');
    expect(fs.existsSync(path.join(workdir, 'last.txt'))).toBe(false);
    // the call is still consumed
    expect(await readConsumed(stateDir)).toEqual([0]);
  });

  it('exit-nonzero emits no events at all', async () => {
    const { scenarioPath, stateDir } = await setup('exit-nonzero.json');
    const res = await run(['exec', '--json', 'go'], { scenarioPath, stateDir });
    expect(res.code).toBe(7);
    expect(res.stdout).toBe('');
    expect(res.stderr.trim()).toBe('codex-sim: simulated failure');
    expect(await readConsumed(stateDir)).toEqual([0]);
  });

  it('hang + SIGINT exits 130 quickly', async () => {
    const { scenarioPath, stateDir } = await setup('hang.json');
    const { child, done, snapshot } = launch(['exec', '--json', 'go'], { scenarioPath, stateDir });

    // wait until the pre-hang events are out
    const deadline = Date.now() + 3000;
    while (!snapshot().stdout.includes('turn.started') && Date.now() < deadline) {
      await sleep(20);
    }
    expect(snapshot().stdout).toContain('"type":"turn.started"');
    expect(snapshot().closed).toBe(false);

    const started = Date.now();
    child.kill('SIGINT');
    const res = await done;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.code).toBe(130);
    expect(res.signal).toBe(null);
    expect(res.stdout).not.toContain('turn.completed');
  });

  it('stubbornSigint ignores SIGINT so callers must SIGKILL', async () => {
    const { scenarioPath, stateDir } = await setup('hang-stubborn.json');
    const { child, done, snapshot } = launch(['exec', '--json', 'go'], { scenarioPath, stateDir });

    const deadline = Date.now() + 3000;
    while (!snapshot().stdout.includes('turn.started') && Date.now() < deadline) {
      await sleep(20);
    }
    expect(snapshot().closed).toBe(false);

    child.kill('SIGINT');
    await sleep(200);
    expect(snapshot().closed).toBe(false);
    child.kill('SIGINT'); // a second one is ignored too
    await sleep(100);
    expect(snapshot().closed).toBe(false);

    child.kill('SIGKILL');
    const res = await done;
    expect(res.signal).toBe('SIGKILL');
    expect(res.code).toBe(null);
  });
});

describe('argv and environment errors', () => {
  it('reads the prompt from stdin with "-"', async () => {
    const { scenarioPath, stateDir } = await setup('happy.json');
    const res = await run(['exec', '--json', '-'], {
      scenarioPath,
      stateDir,
      input: 'Execute assignment.md in this directory.\n',
    });
    expect(res.code).toBe(0);
    expect(events(res.stdout)[0].thread_id).toBe('sim-0001');
    const log = await readLog(stateDir);
    expect(log[0].prompt).toBe('Execute assignment.md in this directory.\n');
  });

  it('reads the prompt from piped stdin when no prompt argument is given', async () => {
    const { scenarioPath, stateDir } = await setup('happy.json');
    const res = await run(['exec', '--json'], {
      scenarioPath,
      stateDir,
      input: 'Execute assignment.md in this directory.',
    });
    expect(res.code).toBe(0);
    expect(events(res.stdout)[0].thread_id).toBe('sim-0001');
  });

  it('rejects unknown flags with exit 2', async () => {
    const { scenarioPath, stateDir } = await setup('happy.json');
    const res = await run(['exec', '--json', '--turbo', 'Execute assignment.md'], {
      scenarioPath,
      stateDir,
    });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('unknown flag "--turbo"');
    expect(res.stdout).toBe('');
    expect(fs.existsSync(path.join(stateDir, 'calls.log.jsonl'))).toBe(false);
  });

  it('rejects unknown short flags and missing flag values', async () => {
    const { scenarioPath, stateDir } = await setup('happy.json');
    const short = await run(['exec', '-z', 'x', 'prompt'], { scenarioPath, stateDir });
    expect(short.code).toBe(2);
    expect(short.stderr).toContain('unknown flag "-z"');

    const missing = await run(['exec', '--output-last-message'], { scenarioPath, stateDir });
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('requires a value');
  });

  it('accepts --flag=value and attached short values', async () => {
    const { scenarioPath, stateDir, workdir } = await setup('happy.json');
    const res = await run(
      [
        'exec',
        '--json',
        `-C${workdir}`,
        '-sread-only',
        '--output-last-message=last.txt',
        '--color=never',
        'Execute assignment.md in this directory.',
      ],
      { scenarioPath, stateDir },
    );
    expect(res.code).toBe(0);
    expect(fs.existsSync(path.join(workdir, 'last.txt'))).toBe(true);
  });

  it('exits 2 when the scenario env var is missing or unreadable', async () => {
    const { scenarioPath, stateDir } = await setup('happy.json');

    const unset = await run(['exec', '--json', 'x'], { stateDir });
    expect(unset.code).toBe(2);
    expect(unset.stderr).toContain('INVENTIO_SIM_SCENARIO');

    const missing = await run(['exec', '--json', 'x'], {
      scenarioPath: `${scenarioPath}.nope`,
      stateDir,
    });
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('cannot read scenario');

    const badPath = path.join(path.dirname(scenarioPath), 'bad.json');
    await fsp.writeFile(badPath, '{not json');
    const invalid = await run(['exec', '--json', 'x'], { scenarioPath: badPath, stateDir });
    expect(invalid.code).toBe(2);
    expect(invalid.stderr).toContain('not valid JSON');
  });

  it('exits 2 on an unknown subcommand', async () => {
    const { scenarioPath, stateDir } = await setup('happy.json');
    const res = await run(['run', '--json', 'x'], { scenarioPath, stateDir });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('unknown subcommand');

    const noResumeId = await run(['exec', 'resume'], { scenarioPath, stateDir });
    expect(noResumeId.code).toBe(2);
    expect(noResumeId.stderr).toContain('THREAD_ID');
  });

  it('ships an executable bin with a node shebang', async () => {
    const stat = await fsp.stat(BIN);
    expect(stat.mode & 0o111).toBeGreaterThan(0);
    const head = (await fsp.readFile(BIN, 'utf8')).split('\n')[0];
    expect(head).toBe('#!/usr/bin/env node');
  });
});
