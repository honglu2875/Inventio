/**
 * Scenario loading, cross-invocation state (consumed calls + call log),
 * and call selection.
 */

import fs from 'node:fs';
import path from 'node:path';

export class SimError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SimError';
  }
}

export const BEHAVIORS = new Set([
  'ok',
  'malformed-output',
  'crash-mid-stream',
  'hang',
  'exit-nonzero',
]);

/**
 * Read + validate the scenario file.
 * @param {string} scenarioPath absolute path
 */
export function loadScenario(scenarioPath) {
  let raw;
  try {
    raw = fs.readFileSync(scenarioPath, 'utf8');
  } catch (err) {
    throw new SimError(`cannot read scenario "${scenarioPath}": ${err.code ?? err.message}`);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new SimError(`scenario "${scenarioPath}" is not valid JSON: ${err.message}`);
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new SimError(`scenario "${scenarioPath}" must be a JSON object`);
  }
  if (!Array.isArray(doc.calls)) {
    throw new SimError(`scenario "${scenarioPath}" must have a "calls" array`);
  }
  for (const [idx, call] of doc.calls.entries()) {
    if (call === null || typeof call !== 'object' || Array.isArray(call)) {
      throw new SimError(`scenario call ${idx} must be a JSON object`);
    }
    const behavior = call.behavior ?? 'ok';
    if (!BEHAVIORS.has(behavior)) {
      throw new SimError(
        `scenario call ${idx} has unknown behavior "${behavior}" ` +
          `(expected one of: ${[...BEHAVIORS].join(', ')})`,
      );
    }
    if (call.items !== undefined && !Array.isArray(call.items)) {
      throw new SimError(`scenario call ${idx} field "items" must be an array`);
    }
  }
  return doc;
}

/** Resolve + create the state directory. */
export function resolveStateDir({ scenarioPath, envStateDir, originalCwd }) {
  const dir = envStateDir
    ? path.resolve(originalCwd, envStateDir)
    : `${scenarioPath}.state`;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new SimError(`cannot create state dir "${dir}": ${err.code ?? err.message}`);
  }
  return dir;
}

export function consumedPath(stateDir) {
  return path.join(stateDir, 'consumed.json');
}

export function callsLogPath(stateDir) {
  return path.join(stateDir, 'calls.log.jsonl');
}

/** @returns {number[]} */
export function readConsumed(stateDir) {
  const file = consumedPath(stateDir);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new SimError(`cannot read "${file}": ${err.code ?? err.message}`);
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new SimError(`"${file}" is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(doc) || doc.some((n) => !Number.isInteger(n))) {
    throw new SimError(`"${file}" must be a JSON array of integers`);
  }
  return doc;
}

/** Read-modify-write; single-writer assumption, no locking. */
export function markConsumed(stateDir, consumed, index) {
  const next = [...new Set([...consumed, index])].sort((a, b) => a - b);
  fs.writeFileSync(consumedPath(stateDir), `${JSON.stringify(next)}\n`);
  return next;
}

/** Append one invocation record to calls.log.jsonl. */
export function appendCallLog(stateDir, record) {
  fs.appendFileSync(callsLogPath(stateDir), `${JSON.stringify(record)}\n`);
}

/**
 * First non-consumed call whose `match` block passes, or -1.
 *
 * All present match keys must pass. A call declaring `match.resumeOf` is
 * selectable only by a `exec resume <THREAD_ID>` invocation with that exact
 * id; a resume invocation selects only such calls.
 *
 * @param {{calls: any[]}} scenario
 * @param {number[]} consumed
 * @param {{prompt: string, cwd: string, resumeOf: string|null}} ctx
 */
export function selectCall(scenario, consumed, ctx) {
  const taken = new Set(consumed);
  for (let i = 0; i < scenario.calls.length; i += 1) {
    if (taken.has(i)) continue;
    const call = scenario.calls[i];
    const match = call.match ?? {};

    const declaresResume =
      Object.prototype.hasOwnProperty.call(match, 'resumeOf') &&
      match.resumeOf !== null &&
      match.resumeOf !== undefined;

    if (ctx.resumeOf === null) {
      if (declaresResume) continue;
    } else if (!declaresResume || match.resumeOf !== ctx.resumeOf) {
      continue;
    }

    if (
      match.promptContains !== null &&
      match.promptContains !== undefined &&
      !ctx.prompt.includes(match.promptContains)
    ) {
      continue;
    }
    if (
      match.cwdContains !== null &&
      match.cwdContains !== undefined &&
      !ctx.cwd.includes(match.cwdContains)
    ) {
      continue;
    }
    return i;
  }
  return -1;
}
