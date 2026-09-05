import {
  Assessment, FrozenResult, ResearchAuthorOutput, ResearchAuditOutput, ResearchCheckOutput,
  ResearchEditorialOutput, ResearchFinalOutput, ResultSubmission, auditCoverage, resultMathematics,
  resultStatus, usageSpend, type ProjectState, type ResearchChange, type ResearchRole,
  type ResearchRound, type ResearchSession, type ResearchTurn, type Usage,
  type FrozenResult as FrozenResultT, type ResultSubmission as Submission,
  type ResearchAuthorOutput as AuthorOutput, type Assessment as AssessmentT,
} from "@inventio/schema";
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { runStructured } from "../codex/structured.js";
import { addUsage, ZERO_USAGE, CODEX_TURN_BASE_TOKENS, type InterruptReason } from "../codex/runner.js";
import { evidenceIssues, readExecutionEvidence, sha256 } from "../verification/executionEvidence.js";
import { writeFileAtomic, type ProjectPaths } from "../store/projectStore.js";
import { copyIntakeSourcesToPacket } from "./intakeSources.js";
import { WorkerPool } from "./pool.js";
import type { EngineDeps } from "./engine.js";
import type { TaskScope } from "../memory/types.js";
import {
  AUDIT_PROMPT, AUDIT_TAIL_PROMPT, CHECK_PROMPT, EDITOR_PROMPT, FINAL_PROMPT,
  REPAIR_PROMPT, RESEARCH_PROMPT, authorFiles, editorialFiles, independentFiles,
  qualifiedRecord, researchIndex, responseMathematics, recoveryPrompt,
} from "../prompts/recurrent.js";

export interface RecurrentHost {
  state: ProjectState;
  paths: ProjectPaths;
  deps: EngineDeps;
  emit(change: ResearchChange): void;
  stopped(): boolean;
  blocked(): boolean;
  wait(): Promise<void>;
  registerKill(id: string, kill: ((reason: InterruptReason) => void) | null): void;
  question(text: string, context: string): void;
  terminal(result: "PROVED" | "DISPROVED" | "UNCERTAIN", markdown: string): void;
}
interface SavedTurn { output: unknown; status: "completed" | "interrupted" | "failed"; usage: Usage | null; chargedTokens: number; elapsedMs: number; error: string | null }
const SUPPORT_LIMIT = 250_000;
const EDITOR_LIMIT = 150_000;
const WRITER_LIMIT = 500_000;
const MIN_CALL = CODEX_TURN_BASE_TOKENS + 4_000;
const MAX_RESPONSES = 2;
const checkable = (v: FrozenResultT): boolean => v.kind === "PROPOSITION" || v.kind === "CALCULATION";

/** Deterministic recurrence. Models never schedule or modify shared state. */
export class RecurrentResearch {
  private roleQueues = new Map<string, Promise<unknown>>();
  private checking = new Map<string, Promise<void>>();
  private checkErrors: unknown[] = [];
  private repairing = new Map<string, Promise<void>>();
  private reservations = new Map<string, number>();
  private pool: WorkerPool;
  constructor(private host: RecurrentHost) {
    this.pool = new WorkerPool(Math.max(1, host.state.config?.limits.maxConcurrentWorkers ?? 4));
  }
  private get s() { return this.host.state.research; }
  private emit(c: ResearchChange): void { this.host.emit(c); }
  private next(prefix: string, ids: string[]): string {
    return `${prefix}${String(Math.max(0, ...ids.map(id => Number(id.slice(prefix.length))).filter(Number.isFinite)) + 1).padStart(3, "0")}`;
  }
  private available(): number {
    const b = this.host.state.budget;
    return Math.max(0, b.totalTokens - b.spentTokens - b.plannerSpentTokens - [...this.reservations.values()].reduce((a, b) => a + b, 0));
  }
  private session(round: ResearchRound, role: ResearchRole, unique = true): ResearchSession {
    const existing = unique ? round.sessionIds.map(id => this.s.sessions[id]!).find(s => s.role === role) : undefined;
    if (existing) return existing;
    const id = this.next("S", Object.keys(this.s.sessions));
    const model = ["verifier", "editor"].includes(role) ? round.supportModel : round.researchModel;
    this.emit({ kind: "session.opened", id, roundId: round.id, role, model });
    return this.s.sessions[id]!;
  }
  private async serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const before = this.roleQueues.get(key) ?? Promise.resolve();
    const next = before.catch(() => undefined).then(fn);
    this.roleQueues.set(key, next);
    try { return await next; } finally { if (this.roleQueues.get(key) === next) this.roleQueues.delete(key); }
  }
  private dir(sessionId: string): string { return path.join(this.host.paths.dir, "research", "sessions", sessionId); }
  private packet(sessionId: string): string { return path.join(this.dir(sessionId), "packet"); }
  private turnDir(id: string): string { return path.join(this.host.paths.dir, "research", "turns", id); }
  private allowed(targets: string[]): FrozenResultT[] {
    const seen = new Set<string>();
    const visit = (id: string): void => {
      if (seen.has(id)) return;
      const v = this.s.versions[id];
      if (!v) throw new Error(`Unknown mathematical dependency ${id}`);
      seen.add(id); v.dependencies.forEach(visit);
    };
    targets.forEach(visit);
    return [...seen].map(id => this.s.versions[id]!);
  }
  private allowance(purpose: ResearchTurn["purpose"]): number {
    const worker = this.host.state.config.budget.defaultTaskTokens;
    const reserve = purpose === "final" ? 0 : Math.min(WRITER_LIMIT, this.host.state.budget.totalTokens / 10);
    const available = Math.max(0, this.available() - reserve);
    if (purpose === "research") return Math.min(worker, Math.floor(Math.max(0, available - worker) / 2));
    return Math.floor(Math.min(purpose === "editorial" ? EDITOR_LIMIT : purpose === "check" ? SUPPORT_LIMIT : purpose === "final" ? WRITER_LIMIT : worker, available));
  }
  private async turn<T>(session: ResearchSession, roundId: string, purpose: ResearchTurn["purpose"], files: Record<string, string>, prompt: string, schema: z.ZodType<T>, targets: string[] = [], objectionIds: string[] = []): Promise<{ output: T | null; turn: ResearchTurn | null }> {
    return this.serial(session.role === "solver" || session.role === "explorer" ? session.role : session.id, async () => {
      while (!this.host.stopped() && this.host.blocked()) await this.host.wait();
      if (this.host.stopped()) return { output: null, turn: null };
      let turn = session.turnIds.map(id => this.s.turns[id]!).find(t => t.status === "running");
      if (!turn) {
        const budgetTokens = this.allowance(purpose);
        if (budgetTokens < MIN_CALL) return { output: null, turn: null };
        const id = this.next("U", Object.keys(this.s.turns));
        this.emit({ kind: "turn.opened", id, sessionId: session.id, roundId, purpose, targets: targets.map(id => ({ versionId: id, hash: this.s.versions[id]!.hash })), objectionIds, budgetTokens, resumeThreadId: session.threadId });
        turn = this.s.turns[id]!;
      }
      const current = turn;
      const turnDir = this.turnDir(current.id);
      const packet = this.packet(session.id);
      const savedPath = path.join(turnDir, "return.json");
      let saved: SavedTurn | null = null;
      if (existsSync(savedPath)) {
        try { saved = JSON.parse(readFileSync(savedPath, "utf8")) as SavedTurn; } catch { /* incomplete return is not evidence */ }
      }
      if (saved && saved.status === "completed") {
        const parsed = schema.safeParse(saved.output);
        if (parsed.success) {
          this.emit({ kind: "turn.completed", id: current.id, status: saved.status, usage: saved.usage, chargedTokens: saved.chargedTokens, elapsedMs: saved.elapsedMs, error: saved.error, outputPath: path.relative(this.host.paths.dir, savedPath) });
          return { output: parsed.data, turn: current };
        }
      }
      const recovering = existsSync(path.join(turnDir, "started.json"));
      mkdirSync(turnDir, { recursive: true });
      mkdirSync(path.join(packet, "scratch"), { recursive: true });
      mkdirSync(path.join(packet, "notes"), { recursive: true });
      // Initial files stay byte-for-byte stable for an author's repair. Only
      // explicitly appended feedback and an auditor's new targets are written.
      for (const [name, content] of Object.entries(files)) {
        if ((recovering || purpose === "repair") && name !== "objections.md" && existsSync(path.join(packet, name))) continue;
        writeFileAtomic(path.join(packet, name), content);
      }
      if (!recovering && session.turnIds.length === 1) copyIntakeSourcesToPacket(this.host.paths, this.host.state.problem.sources, packet);
      const blind = session.role === "verifier" || session.role === "auditor";
      const scope: TaskScope = {
        slug: this.host.state.slug, taskId: session.id, waveId: roundId, role: session.role,
        turnId: current.id, ...(blind ? { allowedVersionIds: this.allowed(current.targets.map(t => t.versionId)).map(v => v.id) } : {}),
      };
      const token = this.host.deps.memory?.mintToken(scope);
      const archive = path.join(turnDir, "codex-events.jsonl");
      const previousCharge = saved?.chargedTokens ?? (recovering ? current.estimatedTokens : 0);
      const started = Date.now();
      let lastProgressAt = 0;
      writeFileAtomic(path.join(turnDir, "started.json"), JSON.stringify({ sessionId: session.id, model: session.model, purpose, targets: current.targets }));
      this.reservations.set(current.id, Math.max(0, current.budgetTokens - previousCharge));
      try {
        const result = await this.pool.run(() => this.host.deps.pool.run(() => runStructured({
          bin: this.host.deps.codexBin, cwd: packet, prompt: recovering ? recoveryPrompt(prompt) : prompt,
          sandbox: "workspace-write", permissionProfile: { name: "inventio_research", filesystem: { ":minimal": "read", [packet]: "write" } },
          isolatedTask: true, model: session.model.model, effort: session.model.effort,
          webSearch: this.host.state.config.allowWebSearch,
          eventsArchiveFile: archive,
          outputSchemaFile: path.join(turnDir, "schema.json"), outputLastMessageFile: path.join(turnDir, "last-message.json"),
          ...(session.threadId ? { resumeThreadId: session.threadId } : {}),
          ...(this.host.deps.memory && token ? { mcp: { serverName: "memory", url: this.host.deps.memory.url, tokenEnvVar: "INVENTIO_TASK_TOKEN", token,
            enabledTools: blind ? ["research_search", "research_open", "source_list", "source_open", ...(session.role === "auditor" ? ["audit_assess"] : [])] : ["research_search", "research_open", "source_list", "source_open", ...(session.role === "solver" || session.role === "explorer" ? ["research_checkpoint"] : [])] } } : {}),
          maxEstimatedTokens: Math.max(1, current.budgetTokens - previousCharge),
          baseEstimatedTokens: CODEX_TURN_BASE_TOKENS + Math.ceil(Object.values(files).reduce((n, s) => n + s.length, 0) / 4),
          wallClockMs: this.host.deps.taskWallClockMsOverride ?? this.host.state.config.budget.taskWallClockMinutes * 60_000,
          killGraceMs: this.host.deps.killGraceMs ?? 10_000,
          onThread: threadId => { if (session.threadId !== threadId) this.emit({ kind: "session.thread", id: session.id, threadId }); },
          onProgress: progress => {
            const now = Date.now();
            if (!this.host.stopped() && now - lastProgressAt >= (this.host.deps.progressThrottleMs ?? 2000)) {
              lastProgressAt = now;
              this.emit({ kind: "turn.progress", id: current.id, estimatedTokens: previousCharge + progress.estimatedTokens });
            }
          },
          registerKill: kill => this.host.registerKill(current.id, kill),
        }, schema)));
        const chargedTokens = previousCharge + result.runs.reduce((n, r) => n + (r.usage ? usageSpend(r.usage) : Math.max(MIN_CALL, r.estimatedTokens)), 0);
        saved = { output: result.output, status: result.status, usage: result.runs.some(r => r.usage) || saved?.usage ? addUsage(saved?.usage ?? ZERO_USAGE, result.usage) : null, chargedTokens, elapsedMs: Date.now() - started, error: result.errorDetail ?? result.validationErrors?.join("; ") ?? null };
        writeFileAtomic(savedPath, JSON.stringify(saved));
        if (this.host.stopped()) return { output: null, turn: current };
        this.emit({ kind: "turn.completed", id: current.id, status: result.status, usage: result.runs.some(r => r.usage) || saved?.usage ? addUsage(saved?.usage ?? ZERO_USAGE, result.usage) : null, chargedTokens, elapsedMs: saved.elapsedMs, error: saved.error, outputPath: path.relative(this.host.paths.dir, savedPath) });
        return { output: result.output, turn: current };
      } finally {
        this.reservations.delete(current.id);
        this.host.registerKill(current.id, null);
        if (token) this.host.deps.memory?.revokeToken(token);
      }
    });
  }
  private recoverOutput<T>(turn: ResearchTurn, schema: z.ZodType<T>): T | null {
    try {
      const saved = JSON.parse(readFileSync(path.join(this.turnDir(turn.id), "return.json"), "utf8")) as SavedTurn;
      const parsed = schema.safeParse(saved.output);
      return saved.status === "completed" && parsed.success ? parsed.data : null;
    } catch { return null; }
  }
  private readNoteFile(sessionId: string, relative: string): string {
    const root = path.join(this.packet(sessionId), "notes");
    const normalized = relative.replaceAll("\\", "/");
    if (!normalized.startsWith("notes/") || normalized.split("/").some(p => p === ".." || p === ".")) throw new Error("Attachments must be ordinary files under notes/");
    const file = path.resolve(this.packet(sessionId), normalized);
    if (!file.startsWith(root + path.sep)) throw new Error("Note path escapes its directory");
    let cursor = this.packet(sessionId);
    for (const part of normalized.split("/")) {
      cursor = path.join(cursor, part);
      if (lstatSync(cursor).isSymbolicLink()) throw new Error("Note snapshots cannot follow symbolic links");
    }
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.size > 200_000) throw new Error("Notes must be text files of at most 200000 bytes; split larger notes");
    if (!realpathSync(file).startsWith(realpathSync(root) + path.sep)) throw new Error("Note path escapes its directory");
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.size > 200_000 || before.ino !== stat.ino || before.dev !== stat.dev) throw new Error("Note changed while being captured; retry the checkpoint");
      const value = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(fd));
      const after = fstatSync(fd);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || Buffer.byteLength(value) > 200_000) throw new Error("Note changed while being captured; retry the checkpoint");
      if (value.includes("\0")) throw new Error("Binary notes are not mathematical text");
      return value;
    } finally { closeSync(fd); }
  }
  snapshotNotes(sessionId: string, roundId: string): string[] {
    const root = path.join(this.packet(sessionId), "notes");
    if (!existsSync(root)) return [];
    if (lstatSync(root).isSymbolicLink()) throw new Error("Notes tree cannot be a symbolic link");
    const names: string[] = [];
    let visited = 0;
    const walk = (dir: string, depth = 0): void => {
      if (depth > 16 || ++visited > 512) throw new Error("Notes tree is too deeply nested; consolidate directories");
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (names.length >= 256) throw new Error("A checkpoint supports at most 256 note files; consolidate the notes tree");
        if (entry.isSymbolicLink()) throw new Error("Notes tree contains a symbolic link");
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file, depth + 1);
        else names.push(path.relative(this.packet(sessionId), file));
      }
    };
    walk(root);
    const ids: string[] = [];
    for (const name of names.sort()) {
      const markdown = this.readNoteFile(sessionId, name);
      if (!markdown.trim()) continue;
      const hash = sha256(markdown);
      const existing = Object.values(this.s.notes).find(n => n.sessionId === sessionId && n.name === name && n.hash === hash);
      if (existing) { ids.push(existing.id); continue; }
      const id = this.next("N", Object.keys(this.s.notes));
      this.emit({ kind: "note.recorded", id, sessionId, roundId, name, hash, markdown });
      ids.push(id);
    }
    return ids;
  }
  private recordResult(session: ResearchSession, roundId: string, proposal: Submission): string {
    const attachments = proposal.attachmentPaths.map(name => { const content = this.readNoteFile(session.id, name); return { name, content, hash: sha256(content) }; });
    for (const id of proposal.sourceIds) if (!this.host.state.problem.sources.some(s => s.id === id)) throw new Error(`Unknown original source ${id}`);
    const resultId = proposal.resultId ?? this.next("B", [...new Set(this.s.versionOrder.map(id => this.s.versions[id]!.resultId))]);
    const version = this.s.versionOrder.filter(id => this.s.versions[id]!.resultId === resultId).length + 1;
    const { attachmentPaths: _paths, ...body } = proposal;
    const unsigned = { ...body, resultId, version, id: `${resultId}.v${version}`, sessionId: session.id, roundId, attachments, hash: "0".repeat(64) };
    const contentHash = sha256(resultMathematics(unsigned));
    // A repeated checkpoint or recovered final return is idempotent by its
    // complete mathematical body and parent, independent of generated IDs.
    const equivalent = this.s.versionOrder.map(id => this.s.versions[id]!).find(v => v.sessionId === session.id && v.parentVersionId === proposal.parentVersionId && v.kind === proposal.kind && v.title === proposal.title && v.relationToGoal === proposal.relationToGoal && JSON.stringify(v.sourceIds) === JSON.stringify(proposal.sourceIds) && v.statement === proposal.statement && v.proofMarkdown === proposal.proofMarkdown && JSON.stringify(v.dependencies) === JSON.stringify(proposal.dependencies) && JSON.stringify(v.attachments) === JSON.stringify(attachments));
    if (equivalent) return equivalent.id;
    const frozen = FrozenResult.parse({ ...unsigned, hash: contentHash });
    this.emit({ kind: "result.recorded", result: frozen });
    return frozen.id;
  }
  checkpoint(scope: TaskScope, proposals: unknown[]): { notes: string[]; results: string[] } {
    const session = this.s.sessions[scope.taskId];
    const turn = scope.turnId ? this.s.turns[scope.turnId] : undefined;
    if (!session || !turn || turn.status !== "running" || turn.purpose !== "research" || !["solver", "explorer"].includes(session.role)) throw new Error("Only an active research turn may submit a checkpoint");
    const notes = this.snapshotNotes(session.id, scope.waveId);
    const results = z.array(ResultSubmission).max(24).parse(proposals).map(p => this.recordResult(session, scope.waveId, p));
    results.forEach(id => this.startCheck(id, scope.waveId));
    return { notes, results };
  }
  private materializeAuthor(session: ResearchSession, turn: ResearchTurn, output: AuthorOutput): string[] {
    if (turn.purpose === "repair") {
      if (output.responses.length !== 1 || output.results.length > 1) throw new Error("Repair must answer its single target with at most one revised result");
      const response = output.responses[0]!;
      if (!turn.targets.some(t => t.versionId === response.versionId)) throw new Error("Response target differs from the objection");
      if (response.action === "REVISE" && (response.replacementIndex !== 0 || output.results[0]?.parentVersionId !== response.versionId)) throw new Error("Revision must supply a corrected target version");
      if (response.action !== "REVISE" && output.results.length) throw new Error("A defense must not silently replace the proof");
    } else if (output.responses.length) throw new Error("Research turn cannot impersonate an author repair");
    this.snapshotNotes(session.id, turn.roundId);
    const writeupHash = sha256(output.writeupMarkdown);
    if (!Object.values(this.s.notes).some(n => n.sessionId === session.id && n.hash === writeupHash)) {
      this.emit({ kind: "note.recorded", id: this.next("N", Object.keys(this.s.notes)), sessionId: session.id, roundId: turn.roundId, name: `${turn.id}-writeup.md`, hash: writeupHash, markdown: output.writeupMarkdown });
    }
    const ids = output.results.map(p => this.recordResult(session, turn.roundId, p));
    for (const response of output.responses) {
      if (this.s.responses.some(r => r.turnId === turn.id && r.response.versionId === response.versionId)) continue;
      this.emit({ kind: "response.recorded", id: this.next("AR", this.s.responses.map(r => r.id)), turnId: turn.id, sessionId: session.id, roundId: turn.roundId, response, replacementVersionId: response.replacementIndex === null ? null : ids[response.replacementIndex] ?? null });
    }
    for (const q of output.questions) this.host.question(q.text, q.context);
    return ids;
  }
  private async author(round: ResearchRound, role: "solver" | "explorer"): Promise<void> {
    const session = this.session(round, role);
    const completed = session.turnIds.map(id => this.s.turns[id]!).find(t => t.purpose === "research" && t.status !== "running");
    if (completed) {
      const output = this.recoverOutput(completed, ResearchAuthorOutput);
      if (output) this.materializeAuthor(session, completed, output).forEach(id => this.startCheck(id, round.id));
      return;
    }
    const result = await this.turn(session, round.id, "research", authorFiles(this.host.state, round, role), RESEARCH_PROMPT, ResearchAuthorOutput);
    if (result.output && result.turn) this.materializeAuthor(session, result.turn, result.output).forEach(id => this.startCheck(id, round.id));
  }
  private recordAssessment(turn: ResearchTurn, raw: AssessmentT): void {
    const session = this.s.sessions[turn.sessionId]!;
    const prior = this.s.assessments.find(a => a.turnId === turn.id && a.assessment.versionId === raw.versionId);
    if (prior) {
      const captured = JSON.parse(readFileSync(path.join(this.host.paths.dir, prior.evidencePath), "utf8")) as { original: AssessmentT };
      if (JSON.stringify(captured.original) !== JSON.stringify(raw)) throw new Error("Conflicting assessments within one turn");
      return;
    }
    const archive = readExecutionEvidence(path.join(this.turnDir(turn.id), "codex-events.jsonl"));
    const issues = evidenceIssues(raw.evidence, true, archive);
    const valid = issues.length === 0;
    const assessment: AssessmentT = !valid && raw.verdict !== "UNABLE" ? { ...raw, verdict: "UNABLE", finding: "OPERATIONAL", scopeSupported: false, reasonMarkdown: `Computational support was not established: ${issues.join(" ")}\n\n${raw.reasonMarkdown}` } : session.role === "verifier" && raw.verdict === "RETRACT" ? { ...raw, verdict: "QUARANTINE" } : raw;
    const evidencePath = path.join("research", "turns", turn.id, `${raw.versionId}-evidence.json`);
    writeFileAtomic(path.join(this.host.paths.dir, evidencePath), JSON.stringify({ original: raw, capture: archive, issues }, null, 2));
    this.emit({ kind: "assessment.recorded", id: this.next("A", this.s.assessments.map(a => a.id)), turnId: turn.id, sessionId: session.id, roundId: turn.roundId, mode: session.role === "auditor" ? "audit" : "check", assessment, evidencePath, evidenceValid: valid, evidenceIssues: issues });
  }
  assess(scope: TaskScope, raw: unknown): void {
    const turn = scope.turnId ? this.s.turns[scope.turnId] : undefined;
    if (!turn || turn.status !== "running" || this.s.sessions[scope.taskId]?.role !== "auditor" || turn.sessionId !== scope.taskId) throw new Error("Only the active independent audit may assess memory");
    const assessment = Assessment.parse(raw);
    if (assessment.verdict === "CONFIRM" && assessment.evidence.basis !== "derivation") throw new Error("Return computational confirmations at turn completion so the complete execution archive can be validated");
    this.recordAssessment(turn, assessment);
  }
  private startCheck(id: string, roundId: string): void {
    if (!checkable(this.s.versions[id]!) || this.checking.has(id)) return;
    const promise = this.check(id, roundId).catch(error => { this.checkErrors.push(error); }).finally(() => this.checking.delete(id));
    this.checking.set(id, promise);
  }
  private async check(id: string, roundId: string): Promise<void> {
    const round = this.s.rounds[roundId]!;
    const version = this.s.versions[id]!;
    const oldTurn = Object.values(this.s.turns).find(t => t.purpose === "check" && t.targets.some(target => target.versionId === id));
    const session = oldTurn ? this.s.sessions[oldTurn.sessionId]! : this.session(round, "verifier", false);
    let output;
    let turn;
    if (oldTurn && oldTurn.status !== "running") { output = this.recoverOutput(oldTurn, ResearchCheckOutput); turn = oldTurn; }
    else ({ output, turn } = await this.turn(session, roundId, "check", independentFiles(this.host.state, "verifier", [version], this.allowed([id])), CHECK_PROMPT, ResearchCheckOutput, [id]));
    if (output && turn) this.recordAssessment(turn, output.assessment);
    const objection = this.s.assessments.find(a => a.mode === "check" && a.assessment.versionId === id && !["CONFIRM", "UNABLE"].includes(a.assessment.verdict));
    if (objection) await this.repair(id, roundId, [objection.id]);
  }
  private async repair(id: string, roundId: string, objectionIds: string[]): Promise<void> {
    const version = this.s.versions[id]!;
    const key = version.resultId;
    if (this.repairing.has(key)) { await this.repairing.get(key); return; }
    const promise = this.doRepair(id, roundId, objectionIds).finally(() => this.repairing.delete(key));
    this.repairing.set(key, promise);
    await promise;
  }
  private async doRepair(id: string, roundId: string, objectionIds: string[]): Promise<void> {
    const version = this.s.versions[id]!;
    const session = this.s.sessions[version.sessionId]!;
    if (this.s.responses.some(r => r.response.versionId === id && ["REVISE", "WITHDRAW"].includes(r.response.action))) return;
    const repairs = Object.values(this.s.turns).filter(t => t.purpose === "repair" && t.roundId === roundId && t.targets.some(target => this.s.versions[target.versionId]?.resultId === version.resultId));
    if (this.s.responses.some(r => r.response.versionId === id && objectionIds.every(ref => r.response.objectionIds.includes(ref)))) return;
    const pending = repairs.find(t => t.targets.some(target => target.versionId === id) && objectionIds.every(ref => t.objectionIds.includes(ref)));
    if (pending && pending.status !== "running") {
      const output = this.recoverOutput(pending, ResearchAuthorOutput);
      if (output) this.materializeAuthor(session, pending, output).forEach(id => this.startCheck(id, roundId));
      return;
    }
    if (!pending && repairs.length >= MAX_RESPONSES) return;
    // A missing provider session is visible, never silently reconstructed by a new author.
    if (!session.threadId) {
      this.host.question(`The originating conversation for ${id} is unavailable. Its mathematics remains saved; repair requires an explicitly identified fresh context.`, "Operational session recovery");
      return;
    }
    const objections = objectionIds.map(id => this.s.assessments.find(a => a.id === id)!).filter(Boolean);
    const files = { "objections.md": [resultMathematics(version), ...objections.map(a => `# Objection ${a.id} to ${a.assessment.versionId}\n\n${a.assessment.reasonMarkdown}`)].join("\n\n") };
    const result = await this.turn(session, roundId, "repair", files, REPAIR_PROMPT, ResearchAuthorOutput, [id], objectionIds);
    if (result.output && result.turn) this.materializeAuthor(session, result.turn, result.output).forEach(id => this.startCheck(id, roundId));
  }
  private async drainChecks(): Promise<void> {
    while (this.checking.size) await Promise.all([...this.checking.values()]);
    if (this.checkErrors.length) throw this.checkErrors.shift();
  }
  async settle(): Promise<void> {
    while (this.roleQueues.size || this.checking.size || this.repairing.size) await Promise.allSettled([...this.roleQueues.values(), ...this.checking.values(), ...this.repairing.values()]);
  }
  private auditCandidates(): string[] {
    return this.s.versionOrder.filter(id => checkable(this.s.versions[id]!) && resultStatus(this.s, id) !== "RETRACTED");
  }
  private async auditBatch(round: ResearchRound, ids: string[]): Promise<void> {
    // Continue in the same strong conversation in bounded batches; the sealed
    // manifest still covers the complete library, never a sample.
    ids = ids.slice(0, 64);
    const session = this.session(round, "auditor");
    this.emit({ kind: "audit.targets", roundId: round.id, sessionId: session.id, targets: ids.map(id => ({ versionId: id, hash: this.s.versions[id]!.hash })), sealed: false });
    if (!ids.length) return;
    const files = independentFiles(this.host.state, "auditor", ids.map(id => this.s.versions[id]!), this.allowed(ids));
    for (const response of this.s.responses.filter(r => ids.includes(r.response.versionId) && r.response.action === "DEFEND")) files[`mathematics/argument-${response.id}.md`] = responseMathematics(response.response.reasonMarkdown);
    const result = await this.turn(session, round.id, "audit", files, session.turnIds.length ? AUDIT_TAIL_PROMPT : AUDIT_PROMPT, ResearchAuditOutput, ids, this.s.responses.filter(r => ids.includes(r.response.versionId) && r.response.action === "DEFEND").map(r => r.id));
    if (result.output && result.turn) {
      for (const assessment of result.output.assessments) this.recordAssessment(result.turn, assessment);
    }
    const objections = this.s.assessments.filter(a => a.turnId === result.turn?.id && !["CONFIRM", "UNABLE"].includes(a.assessment.verdict));
    for (const objection of objections) await this.repair(objection.assessment.versionId, round.id, [objection.id]);
  }
  private async finishAudit(round: ResearchRound): Promise<void> {
    if (round.audit?.sealed) return;
    if (!round.audit && round.number === 1 && !this.auditCandidates().some(id => ["PROVES", "DISPROVES"].includes(this.s.versions[id]!.relationToGoal))) return;
    // A completed turn is the durable attempt marker. Recovery must not skip
    // targets merely because an interrupted earlier batch was resumed first.
    for (;;) {
      await this.drainChecks();
      if (this.host.stopped()) return;
      const ids = this.auditCandidates().filter(id => {
        const defenses = this.s.responses.filter(r => r.response.versionId === id && r.response.action === "DEFEND").map(r => r.id);
        return !Object.values(this.s.turns).some(t => t.roundId === round.id && t.purpose === "audit" && t.status !== "running" && t.targets.some(target => target.versionId === id) && defenses.every(ref => t.objectionIds.includes(ref)));
      });
      if (!ids.length || this.allowance("audit") < MIN_CALL) break;
      await this.auditBatch(round, ids);
    }
    const session = this.session(round, "auditor");
    this.emit({ kind: "audit.targets", roundId: round.id, sessionId: session.id, targets: this.auditCandidates().map(id => ({ versionId: id, hash: this.s.versions[id]!.hash })), sealed: true });
  }
  private async summarize(round: ResearchRound): Promise<void> {
    if (round.editorial) return;
    const session = this.session(round, "editor");
    const previous = session.turnIds.map(id => this.s.turns[id]!).find(t => t.status !== "running");
    const result = previous ? { output: this.recoverOutput(previous, ResearchEditorialOutput) } : await this.turn(session, round.id, "editorial", editorialFiles(this.host.state, round.id), EDITOR_PROMPT, ResearchEditorialOutput);
    if (this.host.stopped()) return;
    const output = result.output && result.output.referencedVersions.every(id => this.s.versions[id]) ? result.output : null;
    const coverage = auditCoverage(this.s, round.id);
    const canonical = qualifiedRecord(this.host.state);
    const summaryMarkdown = `${output?.summaryMarkdown ?? `# Round ${round.number}\n\nThe recorded mathematical results and unresolved issues follow.`}\n\n## Current mathematical record\n\n${canonical || "No checkable results were established."}\n\nAudit coverage: ${coverage.assessed}/${coverage.total}; ${coverage.complete ? "complete" : "incomplete or not yet required"}.`;
    const briefMarkdown = `${output?.briefMarkdown ?? "Consult the linked mathematical record and open questions; no additional conclusion is established."}\n\n${researchIndex(this.host.state)}`;
    this.emit({ kind: "editorial.recorded", roundId: round.id, summaryMarkdown, briefMarkdown, referencedVersions: output?.referencedVersions ?? [...this.s.versionOrder], fallback: !output });
    writeFileAtomic(path.join(this.host.paths.dir, "research", "rounds", round.id, "summary.md"), summaryMarkdown);
    writeFileAtomic(path.join(this.host.paths.dir, "research", "rounds", round.id, "brief.md"), briefMarkdown);
  }
  private outcome(round: ResearchRound): "PROVED" | "DISPROVED" | null {
    if (!auditCoverage(this.s, round.id).complete) return null;
    const decisive = this.s.versionOrder.filter(id => resultStatus(this.s, id, round.id) === "AUDITED").map(id => this.s.versions[id]!.relationToGoal);
    // Opposing admitted calculations must never become an automatic victory.
    if (decisive.includes("PROVES") && decisive.includes("DISPROVES")) return null;
    const result = decisive.includes("PROVES") ? "PROVED" : decisive.includes("DISPROVES") ? "DISPROVED" : null;
    if (!result) return null;
    const opposite = result === "PROVED" ? "DISPROVES" : "PROVES";
    const openOpposition = this.s.versionOrder.some(id => checkable(this.s.versions[id]!) && this.s.versions[id]!.relationToGoal === opposite && !["AUDITED", "RETRACTED"].includes(resultStatus(this.s, id, round.id)));
    return openOpposition ? null : result;
  }

  private async finalize(round: ResearchRound, reason: string): Promise<void> {
    if (!this.s.final) {
      this.emit({ kind: "final.fixed", result: this.outcome(round) ?? "UNCERTAIN", reason, roundId: round.id,
        eligibleVersions: this.s.versionOrder.filter(id => resultStatus(this.s, id, round.id) === "AUDITED"), auditComplete: auditCoverage(this.s, round.id).complete });
    }
    const final = this.s.final!;
    if (!final.writing) {
      const session = this.session(round, "writer");
      const previous = session.turnIds.map(id => this.s.turns[id]!).find(t => t.status !== "running");
      const result = previous ? { output: this.recoverOutput(previous, ResearchFinalOutput) } : await this.turn(session, round.id, "final", editorialFiles(this.host.state, round.id, true), FINAL_PROMPT, ResearchFinalOutput);
      if (this.host.stopped()) return;
      const output = result.output && result.output.referencedVersions.every(id => this.s.versions[id]) ? result.output : null;
      const markdown = `# Research report\n\nResult: **${final.result}**\n\n${final.reason}\n\n${output?.reportMarkdown ?? "The exposition could not be completed; the exact mathematical record follows."}\n\n## Exact mathematical record\n\n${qualifiedRecord(this.host.state)}\n\nAudit complete: ${final.auditComplete ? "yes" : "no"}.`;
      this.emit({ kind: "final.written", markdown, referencedVersions: output?.referencedVersions ?? [...this.s.versionOrder], fallback: !output });
    }
    this.host.terminal(final.result, this.s.final!.writing!.markdown);
  }
  async run(): Promise<void> {
    this.pool.setMax(this.host.state.config.limits.maxConcurrentWorkers);
    while (!this.host.stopped()) {
      if (this.host.state.terminal) return;
      while (!this.host.stopped() && this.host.blocked()) await this.host.wait();
      if (this.host.stopped()) return;
      let round = this.s.roundOrder.map(id => this.s.rounds[id]!).find(r => r.status !== "closed");
      if (!round) {
        const last = this.s.rounds[this.s.roundOrder.at(-1) ?? ""];
        if (last && (this.s.final || (last.number > this.s.continuedAfterRound && this.outcome(last)) || this.s.roundOrder.length >= this.host.state.config.limits.maxWaves || this.allowance("research") < MIN_CALL)) {
          await this.finalize(last, this.outcome(last) ? "The complete independent audit supports a decisive result." : "The research rounds or available allowance are exhausted; unresolved mathematics remains explicit.");
          return;
        }
        const number = this.s.roundOrder.length + 1;
        const id = `W${String(number).padStart(3, "0")}`;
        const models = this.host.state.config.researchModels;
        this.emit({ kind: "round.opened", id, number,
          briefMarkdown: last?.editorial?.briefMarkdown ?? this.host.state.mathematicalViews.at(-1)?.markdown ?? this.host.state.problem.normalizedMarkdown ?? this.host.state.statement,
          researchModel: models?.research ?? this.host.state.config.models.solver,
          supportModel: models?.support ?? this.host.state.config.models.verifier });
        round = this.s.rounds[id]!;
      }
      if (round.status === "open") {
        // Materialize saved audit output after a crash between return capture
        // and its individual assessment events. Author/check recovery below
        // follows the same immutable return files.
        for (const turn of Object.values(this.s.turns).filter(t => t.roundId === round!.id && t.purpose === "audit" && t.status !== "running")) {
          const output = this.recoverOutput(turn, ResearchAuditOutput);
          if (output) for (const assessment of output.assessments) this.recordAssessment(turn, assessment);
        }
        // Start the independent full-memory audit alongside both long research
        // sessions. Older author repairs share the corresponding role queue.
        const baseline = round.number >= 2 && !round.audit ? this.auditBatch(round, this.auditCandidates()) : Promise.resolve();
        await Promise.all([this.author(round, "solver"), this.author(round, "explorer"), baseline]);
        await this.drainChecks();
        for (const assessment of this.s.assessments.filter(a => a.roundId === round!.id && a.mode === "audit" && !["CONFIRM", "UNABLE"].includes(a.assessment.verdict))) await this.repair(assessment.assessment.versionId, round.id, [assessment.id]);
        await this.finishAudit(round);
        if (this.host.stopped()) return;
        this.emit({ kind: "round.sealed", id: round.id });
      }
      await this.summarize(round);
      if (this.host.stopped()) return;
      this.emit({ kind: "round.closed", id: round.id });
    }
  }
}
