import { initialState, replay, type ProjectState } from "@inventio/schema";
import { readFileSync } from "node:fs";
import path from "node:path";
import { EventLog } from "../store/eventLog.js";
import { EvaluationManifest, type EvaluationRow } from "./score.js";

/** Reads only explicit manifest entries. No scanning, model calls or project writes. */
export function readEvaluationCases(manifestFile: string): EvaluationRow[] {
  const absolute = path.resolve(manifestFile);
  const manifest = EvaluationManifest.parse(JSON.parse(readFileSync(absolute, "utf8")));
  const states = new Map<string, ProjectState>();
  const seen = new Set<string>();
  return manifest.cases.map(entry => {
    const file = path.resolve(path.dirname(absolute), entry.eventsFile);
    const key = `${file}\0${entry.verificationId}\0${entry.variant}`;
    if (seen.has(key)) throw new Error(`verification ${entry.verificationId} appears twice in variant ${entry.variant}`);
    seen.add(key);
    let state = states.get(file);
    if (!state) { state = replay(initialState(), EventLog.read(file)); states.set(file, state); }
    const verification = state.verifications[entry.verificationId];
    if (!verification) throw new Error(`case ${entry.id}: verification ${entry.verificationId} is absent`);
    return { id: entry.id, variant: entry.variant, label: entry.label, verification };
  });
}
