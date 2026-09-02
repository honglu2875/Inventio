import type { Event } from "./events.js";
import { usageSpend } from "./events.js";
import type { ProjectState, TaskState } from "./state.js";
import { idNumber, parseCandidateId, type IdKind } from "./ids.js";

/** Apply only the not-yet-recorded portion of a cumulative task charge. */
function accountTask(state: ProjectState, task: TaskState, chargedTokens: number): void {
  const total = Math.max(0, Math.floor(chargedTokens));
  if (total <= task.chargedTokens) return;
  state.budget.spentTokens += total - task.chargedTokens;
  task.chargedTokens = total;
}

/**
 * Equivalence is transitive. If independently checked proofs have already
 * produced duplicate facts before that relation is recognized, keep the first
 * fact authoritative and retain the others as inspectable, superseded records.
 */
function reconcileEquivalentFacts(state: ProjectState, seedClaimId: string): void {
  const component = new Set<string>();
  const pending = [seedClaimId];
  while (pending.length > 0) {
    const claimId = pending.pop()!;
    if (component.has(claimId)) continue;
    const claim = state.claims[claimId];
    if (!claim) continue;
    component.add(claimId);
    pending.push(...claim.equivalentIds);
  }
  const facts = state.factOrder
    .map((factId) => state.facts[factId]!)
    .filter(
      (fact) =>
        component.has(fact.claimId) &&
        fact.status !== "RETRACTED" &&
        fact.status !== "SUPERSEDED",
    )
    .sort((left, right) => left.recordedAtSeq - right.recordedAtSeq || left.id.localeCompare(right.id));
  const primary = facts[0];
  if (!primary) return;
  for (const duplicate of facts.slice(1)) {
    duplicate.status = "SUPERSEDED";
    duplicate.supersededByFactId = primary.id;
  }
  for (const claimId of component) {
    const claim = state.claims[claimId]!;
    if (claim.status === "VERIFIED" || claim.promotedFactId !== null) {
      claim.promotedFactId = primary.id;
    }
  }
}

/**
 * The pure fold: applyEvent mutates `state` in place and returns it.
 * Callers own copying semantics (the conductor folds its single instance;
 * the UI wraps application in an immer produce). Replay of the same log
 * from initialState() always yields the same state (tested).
 *
 * The reducer applies facts only — it never invents transitions. Events
 * referencing unknown entities throw, which surfaces engine bugs early.
 */
export function applyEvent(state: ProjectState, event: Event): ProjectState {
  if (event.seq <= state.seq) {
    throw new Error(`event seq ${event.seq} not after state seq ${state.seq}`);
  }
  state.seq = event.seq;

  switch (event.type) {
    // ---- lifecycle -------------------------------------------------------
    case "project.created": {
      state.slug = event.slug;
      state.title = event.title;
      state.statement = event.statement;
      state.contextMarkdown = event.contextMarkdown ?? "";
      state.config = event.config;
      state.autonomy = event.config.autonomy;
      state.budget.totalTokens = event.config.budget.totalTokens;
      return state;
    }
    case "project.paused":
      state.paused = true;
      return state;
    case "project.resumed":
      state.paused = false;
      return state;
    case "phase.changed":
      state.phase = event.to;
      return state;
    case "terminal.reached":
      state.terminal = { result: event.result, finalPath: event.finalPath };
      state.terminalHistory.push({
        result: event.result,
        finalPath: event.finalPath,
        reachedAtSeq: event.seq,
      });
      return state;
    case "publication.requested": {
      const terminal = must(state.terminal ?? undefined, "terminal report");
      const checkpoint = must(state.terminalHistory.at(-1), "terminal checkpoint");
      const decision = must(state.decisions[event.decisionId], `decision ${event.decisionId}`);
      if (decision.kind !== "publication") {
        throw new Error(`decision ${event.decisionId} is not a publication decision`);
      }
      if (
        terminal.result !== event.terminalResult ||
        terminal.finalPath !== event.terminalFinalPath ||
        checkpoint.reachedAtSeq !== event.terminalReachedAtSeq
      ) {
        throw new Error(`publication ${event.publicationId} does not match the current stopping checkpoint`);
      }
      bump(state, "publication", event.publicationId);
      state.publications.push({
        id: event.publicationId,
        decisionId: event.decisionId,
        status: "drafting",
        terminalResult: event.terminalResult,
        terminalFinalPath: event.terminalFinalPath,
        terminalReachedAtSeq: event.terminalReachedAtSeq,
        requestedAtSeq: event.seq,
        requestedBy: event.by,
        kind: null,
        result: null,
        title: null,
        assessment: null,
        texPath: null,
        pdfPath: null,
        logPath: null,
        compiler: null,
        failureStage: null,
        error: null,
        completedAtSeq: null,
      });
      return state;
    }
    case "publication.drafted": {
      const publication = must(
        state.publications.find((entry) => entry.id === event.publicationId),
        `publication ${event.publicationId}`,
      );
      if (
        (event.kind === "preprint" && event.result === "UNCERTAIN") ||
        (event.kind === "research_report" && event.result !== "UNCERTAIN")
      ) {
        throw new Error(
          `publication ${event.publicationId} has incompatible kind ${event.kind} and result ${event.result}`,
        );
      }
      publication.status = "drafted";
      publication.kind = event.kind;
      publication.result = event.result;
      publication.title = event.title;
      publication.assessment = event.assessment;
      publication.texPath = event.texPath;
      publication.logPath = event.logPath;
      publication.failureStage = null;
      publication.error = null;
      return state;
    }
    case "publication.compilationRequested": {
      const publication = must(
        state.publications.find((entry) => entry.id === event.publicationId),
        `publication ${event.publicationId}`,
      );
      if (publication.texPath === null) {
        throw new Error(`publication ${event.publicationId} has no TeX source to recompile`);
      }
      publication.status = "compiling";
      publication.failureStage = null;
      publication.error = null;
      return state;
    }
    case "publication.completed": {
      const publication = must(
        state.publications.find((entry) => entry.id === event.publicationId),
        `publication ${event.publicationId}`,
      );
      if (publication.texPath === null || publication.kind === null || publication.result === null) {
        throw new Error(`publication ${event.publicationId} completed before a manuscript was accepted`);
      }
      publication.status = "ready";
      publication.pdfPath = event.pdfPath;
      publication.compiler = event.compiler;
      publication.failureStage = null;
      publication.error = null;
      publication.completedAtSeq = event.seq;
      return state;
    }
    case "publication.failed": {
      const publication = must(
        state.publications.find((entry) => entry.id === event.publicationId),
        `publication ${event.publicationId}`,
      );
      publication.status = "failed";
      publication.failureStage = event.stage;
      publication.error = event.error;
      return state;
    }
    case "project.continued": {
      const terminal = must(state.terminal ?? undefined, "terminal report");
      if (
        terminal.result !== event.previousResult ||
        terminal.finalPath !== event.previousFinalPath
      ) {
        throw new Error("continued project does not match its current terminal report");
      }
      state.continuations.push({
        previousResult: event.previousResult,
        previousFinalPath: event.previousFinalPath,
        note: event.note,
        addTokens: event.addTokens,
        addWaves: event.addWaves,
        by: event.by,
        atSeq: event.seq,
      });
      state.terminal = null;
      state.budget.totalTokens += event.addTokens;
      state.config.budget.totalTokens += event.addTokens;
      state.config.limits.maxWaves += event.addWaves;
      return state;
    }
    case "autonomy.changed":
      state.config.autonomy = event.mode;
      state.autonomy = event.mode;
      return state;
    case "models.changed":
      state.config.models = {
        ...state.config.models,
        ...event.models,
        summaryReader: event.models.summaryReader ?? state.config.models.summaryReader,
        verifier: event.models.verifier ?? state.config.models.verifier,
      };
      return state;
    case "webSearch.changed":
      state.config.allowWebSearch = event.enabled;
      return state;
    case "project.settingsChanged":
      state.config.models = {
        ...state.config.models,
        ...event.settings.models,
        summaryReader:
          event.settings.models.summaryReader ?? state.config.models.summaryReader,
        verifier: event.settings.models.verifier ?? state.config.models.verifier,
      };
      state.config.autonomy = event.settings.autonomy;
      state.config.allowWebSearch = event.settings.allowWebSearch;
      state.config.budget.totalTokens = event.settings.totalTokens;
      state.budget.totalTokens = event.settings.totalTokens;
      if (event.settings.workerTokenLimit !== undefined) {
        state.config.budget.defaultTaskTokens = event.settings.workerTokenLimit;
      }
      state.config.limits.maxWaves = event.settings.maxWaves;
      if (event.settings.trajectory) {
        state.config.trajectory = { ...event.settings.trajectory };
      }
      // Compatibility projection retained for old UI snapshots. Runtime code
      // reads config.autonomy, so config remains the sole effective setting.
      state.autonomy = event.settings.autonomy;
      return state;

    // ---- intake & human channel -----------------------------------------
    case "intake.rawUpdated":
      state.statement = event.statement;
      state.contextMarkdown = event.contextMarkdown;
      state.problem.rawUpdatedAtSeq = event.seq;
      return state;
    case "intake.completed":
      state.problem.normalizedMarkdown = event.problemMarkdown;
      state.problem.contextDigestMarkdown = event.contextDigestMarkdown ?? "";
      state.problem.rawMemories = event.rawMemories ?? [];
      state.problem.ambiguities = event.ambiguities;
      state.problem.clarifications = event.clarifications;
      return state;
    case "intake.sourcesUpdated": {
      const signature = (sources: typeof event.sources): string =>
        sources.map((source) => `${source.id}\0${source.kind}\0${source.relativePath}\0${source.sha256}`).join("\n");
      if (signature(state.problem.sources) !== signature(event.sources)) {
        state.problem.rawUpdatedAtSeq = event.seq;
      }
      state.problem.sources = event.sources.map((source) => ({ ...source }));
      return state;
    }
    case "intake.answered":
      for (const a of event.answers) state.problem.answers[a.id] = a.answer;
      return state;
    case "intake.revised":
      state.problem.normalizedMarkdown = event.problemMarkdown;
      state.problem.revised = true;
      return state;
    case "problem.confirmed":
      state.problem.confirmedMarkdown = event.problemMarkdown;
      state.problem.contextDigestMarkdown = event.contextDigestMarkdown ?? state.problem.contextDigestMarkdown;
      state.problem.rawMemories = event.rawMemories ?? state.problem.rawMemories;
      return state;
    case "directive.submitted":
      bump(state, "directive", event.id);
      state.directives[event.id] = {
        id: event.id,
        text: event.text,
        urgent: event.urgent,
        status: "pending",
        consumedByDecision: null,
      };
      state.directiveOrder.push(event.id);
      return state;
    case "directive.consumed": {
      const d = must(state.directives[event.id], `directive ${event.id}`);
      d.status = "consumed";
      d.consumedByDecision = event.decisionId;
      return state;
    }
    case "question.raised":
      bump(state, "question", event.id);
      state.questions[event.id] = {
        id: event.id,
        text: event.text,
        blocking: event.blocking,
        context: event.context,
        raisedBy: event.raisedBy,
        interaction:
          event.interaction ??
          (event.raisedBy === "conductor" && event.text.startsWith("Planner call failed:")
            ? "retry"
            : event.raisedBy === "conductor" && event.text.startsWith("Curation call failed")
              ? "acknowledge"
              : "answer"),
        status: "open",
        answer: null,
      };
      return state;
    case "question.answered": {
      const q = must(state.questions[event.id], `question ${event.id}`);
      q.status = "answered";
      q.answer = event.answer;
      return state;
    }
    case "question.dismissed": {
      const q = must(state.questions[event.id], `question ${event.id}`);
      q.status = "dismissed";
      return state;
    }
    case "human.intervention":
      return state; // informational; the concrete effect arrives as its own event

    // ---- decisions -------------------------------------------------------
    case "decision.requested":
      bump(state, "decision", event.decisionId);
      state.decisions[event.decisionId] = {
        id: event.decisionId,
        kind: event.kind,
        waveId: event.waveId,
        status: "requested",
        action: null,
        violations: [],
        gateResolution: null,
        plannerSpend: 0,
      };
      state.decisionOrder.push(event.decisionId);
      return state;
    case "decision.proposed": {
      const d = must(state.decisions[event.decisionId], `decision ${event.decisionId}`);
      d.status = "proposed";
      d.action = event.action;
      if (event.usage) {
        const spend = usageSpend(event.usage);
        d.plannerSpend += spend;
        state.budget.plannerSpentTokens += spend;
      }
      return state;
    }
    case "decision.rejected": {
      const d = must(state.decisions[event.decisionId], `decision ${event.decisionId}`);
      d.status = "rejected";
      d.violations.push(event.violations);
      return state;
    }
    case "decision.accepted": {
      const d = must(state.decisions[event.decisionId], `decision ${event.decisionId}`);
      d.status = "accepted";
      d.action = event.action;
      return state;
    }
    case "gate.opened": {
      const d = must(state.decisions[event.decisionId], `decision ${event.decisionId}`);
      d.status = "gated";
      state.openGateDecisionId = event.decisionId;
      return state;
    }
    case "gate.resolved": {
      const d = must(state.decisions[event.decisionId], `decision ${event.decisionId}`);
      d.status = "gateResolved";
      d.gateResolution = event.resolution;
      if (event.action !== undefined) d.action = event.action;
      if (state.openGateDecisionId === event.decisionId) state.openGateDecisionId = null;
      return state;
    }

    // ---- waves & tasks ---------------------------------------------------
    case "wave.planned": {
      bump(state, "wave", event.waveId);
      state.waves[event.waveId] = {
        id: event.waveId,
        plannedAtSeq: event.seq,
        title: event.title ?? "",
        status: "open",
        decisionId: event.decisionId,
        roster: event.roster,
        reserveTokens: event.reserveTokens,
        rationale: event.rationale,
        taskIds: event.roster.map((r) => r.taskId),
        docketMarkdown: null,
        resolutionPath: null,
        summaryReviewed: false,
        claimsCompared: false,
      };
      state.waveOrder.push(event.waveId);
      for (const entry of event.roster) {
        bump(state, "task", entry.taskId);
        const task: TaskState = {
          id: entry.taskId,
          waveId: event.waveId,
          role: entry.role,
          methodTag: entry.methodTag,
          direction: entry.direction,
          status: "queued",
          budgetTokens: entry.tokenBudget,
          packetManifest: [],
          threadId: null,
          estimatedTokens: 0,
          chargedTokens: 0,
          lastItem: null,
          usage: null,
          artifactIds: [],
          reviewOf: entry.reviewOf,
          computation: entry.computation,
          invalidOutputErrors: null,
          interruptReason: null,
          error: null,
          crossExams: [],
          disposition: null,
          dispositionReason: null,
          preciseUnblock: null,
          milestoneIds: [],
        };
        state.tasks[entry.taskId] = task;
      }
      return state;
    }
    case "wave.softInterrupted": {
      const w = must(state.waves[event.waveId], `wave ${event.waveId}`);
      w.status = "softInterrupted";
      return state;
    }
    case "wave.closed": {
      const w = must(state.waves[event.waveId], `wave ${event.waveId}`);
      w.status = "closed";
      w.docketMarkdown = event.docketMarkdown;
      return state;
    }
    case "wave.claimsCompared": {
      const wave = must(state.waves[event.waveId], `wave ${event.waveId}`);
      wave.claimsCompared = true;
      return state;
    }
    case "task.dispatched": {
      const t = must(state.tasks[event.taskId], `task ${event.taskId}`);
      t.status = "running";
      t.packetManifest = event.packetManifest;
      t.budgetTokens = event.budgetTokens;
      return state;
    }
    case "task.session": {
      const t = must(state.tasks[event.taskId], `task ${event.taskId}`);
      t.threadId = event.threadId;
      return state;
    }
    case "task.progress": {
      const t = must(state.tasks[event.taskId], `task ${event.taskId}`);
      t.estimatedTokens = event.estimatedTokens;
      t.lastItem = event.lastItem;
      return state;
    }
    case "task.completed": {
      const t = must(state.tasks[event.taskId], `task ${event.taskId}`);
      t.status = "completed";
      t.usage = event.usage;
      t.error = null;
      t.interruptReason = null;
      if (event.clearInvalidOutput) t.invalidOutputErrors = null;
      accountTask(state, t, usageSpend(event.usage));
      return state;
    }
    case "task.outputInvalid": {
      const t = must(state.tasks[event.taskId], `task ${event.taskId}`);
      t.invalidOutputErrors = event.errors;
      return state;
    }
    case "task.interrupted": {
      const t = must(state.tasks[event.taskId], `task ${event.taskId}`);
      t.status = "interrupted";
      t.interruptReason = event.reason;
      if (event.usage) {
        t.usage = event.usage;
        accountTask(state, t, usageSpend(event.usage));
      }
      return state;
    }
    case "task.failed": {
      const t = must(state.tasks[event.taskId], `task ${event.taskId}`);
      t.status = "failed";
      t.error = event.error;
      if (event.usage) {
        t.usage = event.usage;
        accountTask(state, t, usageSpend(event.usage));
      }
      return state;
    }
    case "task.accounted": {
      const t = must(state.tasks[event.taskId], `task ${event.taskId}`);
      accountTask(state, t, event.chargedTokens);
      return state;
    }
    case "task.extended": {
      const t = must(state.tasks[event.taskId], `task ${event.taskId}`);
      t.budgetTokens += event.addTokens;
      return state;
    }
    case "task.milestone": {
      bump(state, "milestone", event.milestoneId);
      const task = must(state.tasks[event.taskId], `task ${event.taskId}`);
      if (state.milestones[event.milestoneId]) {
        throw new Error(`duplicate milestone ${event.milestoneId}`);
      }
      state.milestones[event.milestoneId] = {
        id: event.milestoneId,
        taskId: event.taskId,
        title: event.title ?? "",
        markdown: event.markdown,
        recordedAtSeq: event.seq,
        recordedAt: event.ts,
      };
      state.milestoneOrder.push(event.milestoneId);
      task.milestoneIds.push(event.milestoneId);
      return state;
    }
    case "task.dispositioned": {
      const t = must(state.tasks[event.taskId], `task ${event.taskId}`);
      if (t.waveId !== event.waveId) {
        throw new Error(`task ${event.taskId} does not belong to wave ${event.waveId}`);
      }
      t.disposition = event.disposition;
      t.dispositionReason = event.reason;
      t.preciseUnblock = event.unblock;
      return state;
    }
    case "crossexam.sent": {
      const t = must(state.tasks[event.taskId], `task ${event.taskId}`);
      t.crossExams.push({
        questionMarkdown: event.questionMarkdown,
        refIds: event.refIds,
        answerMarkdown: null,
      });
      return state;
    }
    case "crossexam.answered": {
      const t = must(state.tasks[event.taskId], `task ${event.taskId}`);
      const open = t.crossExams.find((x) => x.answerMarkdown === null);
      if (!open) throw new Error(`no open cross-exam on ${event.taskId}`);
      open.answerMarkdown = event.answerMarkdown;
      if (event.usage) state.budget.spentTokens += usageSpend(event.usage);
      return state;
    }

    // ---- evidence --------------------------------------------------------
    case "artifact.recorded": {
      const task = event.taskId
        ? must(state.tasks[event.taskId], `task ${event.taskId}`)
        : null;
      for (const kind of ["attempt", "exploration", "review"] as const) {
        if (event.kind === kind) bump(state, kind, event.artifactId);
      }
      // Long-trajectory write-ups retain the familiar A.../E... identifiers,
      // even though their presentation kind is the shared `writeup` section.
      // Advancing the role-specific counter is essential: otherwise every
      // Solver is allocated A001 and every Explorer E001.
      if (event.kind === "writeup" && task?.role === "solver") {
        bump(state, "attempt", event.artifactId);
      } else if (event.kind === "writeup" && task?.role === "explorer") {
        bump(state, "exploration", event.artifactId);
      }

      // Re-recording an id transfers its ownership. This preserves the
      // existing last-write-wins artifact semantics without leaving the old
      // task pointing at another task's document after replay.
      const previous = state.artifacts[event.artifactId];
      if (previous?.taskId && previous.taskId !== event.taskId) {
        const previousTask = state.tasks[previous.taskId];
        if (previousTask) {
          previousTask.artifactIds = previousTask.artifactIds.filter(
            (artifactId) => artifactId !== event.artifactId,
          );
        }
      }
      state.artifacts[event.artifactId] = {
        id: event.artifactId,
        kind: event.kind,
        taskId: event.taskId,
        path: event.path,
        conclusion: event.conclusion,
        recordedAtSeq: event.seq,
      };
      if (task && !task.artifactIds.includes(event.artifactId)) {
        task.artifactIds.push(event.artifactId);
      }
      return state;
    }
    case "lineage.created":
      bump(state, "lineage", event.lineageId);
      state.lineages[event.lineageId] = {
        id: event.lineageId,
        title: event.title,
        status: "active",
        abandonReason: null,
        establishedCandidateId: null,
        versionIds: [],
      };
      state.activeLineageId = event.lineageId;
      return state;
    case "lineage.abandoned": {
      const l = must(state.lineages[event.lineageId], `lineage ${event.lineageId}`);
      l.status = "abandoned";
      l.abandonReason = event.reason;
      if (state.activeLineageId === event.lineageId) state.activeLineageId = null;
      return state;
    }
    case "lineage.established": {
      const l = must(state.lineages[event.lineageId], `lineage ${event.lineageId}`);
      const c = must(state.candidates[event.candidateId], `candidate ${event.candidateId}`);
      if (c.lineageId !== l.id) throw new Error(`candidate ${c.id} is not in lineage ${l.id}`);
      l.status = "established";
      l.establishedCandidateId = c.id;
      if (state.activeLineageId === l.id) state.activeLineageId = null;
      return state;
    }
    case "candidate.frozen": {
      const parsed = parseCandidateId(event.candidateId);
      if (!parsed || parsed.lineageId !== event.lineageId || parsed.version !== event.version) {
        throw new Error(`malformed candidate id ${event.candidateId}`);
      }
      const l = must(state.lineages[event.lineageId], `lineage ${event.lineageId}`);
      state.candidates[event.candidateId] = {
        id: event.candidateId,
        lineageId: event.lineageId,
        version: event.version,
        fromArtifact: event.fromArtifact,
        obligations: event.obligations,
        reviewQuestions: event.reviewQuestions,
        usedClaimIds: event.usedClaimIds,
        scope: event.scopeMarkdown,
        reviewIds: [],
        issueIds: [],
        acceptance: null,
      };
      l.versionIds.push(event.candidateId);
      return state;
    }
    case "review.recorded": {
      bump(state, "review", event.reviewId);
      const c = must(state.candidates[event.candidateId], `candidate ${event.candidateId}`);
      state.reviews[event.reviewId] = {
        id: event.reviewId,
        candidateId: event.candidateId,
        verdict: event.verdict,
        issueIds: event.issueIds,
        taskId: event.taskId,
      };
      c.reviewIds.push(event.reviewId);
      for (const issueId of event.issueIds) {
        if (!c.issueIds.includes(issueId)) c.issueIds.push(issueId);
      }
      return state;
    }
    case "claim.added":
      bump(state, "claim", event.claimId);
      state.claims[event.claimId] = {
        id: event.claimId,
        title: event.title ?? "",
        statement: event.statement,
        proofMarkdown: event.proofMarkdown ?? "",
        status: event.status,
        provenance: event.provenance,
        sourceTaskId: event.sourceTaskId ?? event.provenance.match(/\(from (T\d+)\)/)?.[1] ?? null,
        sourceWaveId: event.sourceWaveId ?? null,
        path: event.path ?? null,
        relationToGoal: event.relationToGoal ?? "RELATED",
        kind: event.kind ?? "mathematical",
        targetFactId: event.targetFactId ?? null,
        verificationPolicy: event.verificationPolicy ?? null,
        dependsOn: event.dependsOn,
        equivalentIds: [],
        verificationIds: [],
        promotedFactId: null,
        history: [],
      };
      state.claimOrder.push(event.claimId);
      return state;
    case "claim.status": {
      const k = must(state.claims[event.claimId], `claim ${event.claimId}`);
      k.status = event.to;
      k.history.push({
        from: event.from,
        to: event.to,
        justification: event.justification,
        by: event.by,
        seq: event.seq,
      });
      if (event.to === "VERIFIED") reconcileEquivalentFacts(state, k.id);
      return state;
    }
    case "claim.provenanceRepaired": {
      const claim = must(state.claims[event.claimId], `claim ${event.claimId}`);
      if (claim.provenance !== event.from) {
        throw new Error(
          `claim ${event.claimId} provenance is ${claim.provenance}, not ${event.from}`,
        );
      }
      claim.provenance = event.to;
      return state;
    }
    case "claim.equivalent": {
      if (event.leftClaimId === event.rightClaimId) {
        throw new Error(`claim ${event.leftClaimId} cannot be equivalent to itself`);
      }
      const left = must(state.claims[event.leftClaimId], `claim ${event.leftClaimId}`);
      const right = must(state.claims[event.rightClaimId], `claim ${event.rightClaimId}`);
      if (!left.equivalentIds.includes(right.id)) left.equivalentIds.push(right.id);
      if (!right.equivalentIds.includes(left.id)) right.equivalentIds.push(left.id);
      reconcileEquivalentFacts(state, left.id);
      return state;
    }
    case "verification.requested": {
      bump(state, "verification", event.verificationId);
      const claim = must(state.claims[event.claimId], `claim ${event.claimId}`);
      state.verifications[event.verificationId] = {
        id: event.verificationId,
        claimId: event.claimId,
        ordinal: event.ordinal,
        status: "queued",
        verdict: null,
        finding: null,
        summaryMarkdown: "",
        artifactPath: null,
        usage: null,
        requestedAtSeq: event.seq,
        completedAtSeq: null,
      };
      state.verificationOrder.push(event.verificationId);
      claim.verificationIds.push(event.verificationId);
      return state;
    }
    case "verification.started": {
      const verification = must(
        state.verifications[event.verificationId],
        `verification ${event.verificationId}`,
      );
      if (verification.status !== "completed") verification.status = "running";
      return state;
    }
    case "verification.completed": {
      const verification = must(
        state.verifications[event.verificationId],
        `verification ${event.verificationId}`,
      );
      verification.status = "completed";
      verification.verdict = event.verdict;
      verification.finding = event.finding ?? null;
      verification.summaryMarkdown = event.summaryMarkdown;
      verification.artifactPath = event.artifactPath;
      verification.usage = event.usage;
      verification.completedAtSeq = event.seq;
      if (event.usage) state.budget.spentTokens += usageSpend(event.usage);
      return state;
    }
    case "fact.recorded": {
      bump(state, "fact", event.factId);
      const claim = must(state.claims[event.claimId], `claim ${event.claimId}`);
      state.facts[event.factId] = {
        id: event.factId,
        claimId: claim.id,
        title: claim.title,
        statement: claim.statement,
        proofMarkdown: claim.proofMarkdown,
        path: event.path,
        status: "ACTIVE",
        correctionClaimIds: [],
        retractedByClaimId: null,
        supersededByFactId: null,
        recordedAtSeq: event.seq,
      };
      state.factOrder.push(event.factId);
      claim.promotedFactId = event.factId;
      reconcileEquivalentFacts(state, claim.id);
      return state;
    }
    case "fact.suspicionRaised": {
      const fact = must(state.facts[event.factId], `fact ${event.factId}`);
      const correction = must(
        state.claims[event.correctionClaimId],
        `claim ${event.correctionClaimId}`,
      );
      if (correction.kind !== "correction" || correction.targetFactId !== fact.id) {
        throw new Error(`claim ${correction.id} is not a correction of ${fact.id}`);
      }
      if (!fact.correctionClaimIds.includes(correction.id)) {
        fact.correctionClaimIds.push(correction.id);
      }
      if (fact.status === "ACTIVE") fact.status = "SUSPICIOUS";
      return state;
    }
    case "fact.retracted": {
      const fact = must(state.facts[event.factId], `fact ${event.factId}`);
      must(state.claims[event.correctionClaimId], `claim ${event.correctionClaimId}`);
      fact.status = "RETRACTED";
      fact.retractedByClaimId = event.correctionClaimId;
      return state;
    }
    case "fact.suspicionCleared": {
      const fact = must(state.facts[event.factId], `fact ${event.factId}`);
      must(state.claims[event.correctionClaimId], `claim ${event.correctionClaimId}`);
      if (fact.status === "SUSPICIOUS") {
        const stillOpen = fact.correctionClaimIds.some((claimId) => {
          if (claimId === event.correctionClaimId) return false;
          const status = state.claims[claimId]?.status;
          return status === "UNVERIFIED" || status === "NEEDS_REVISION";
        });
        fact.status = stillOpen ? "SUSPICIOUS" : "ACTIVE";
      }
      return state;
    }
    case "issue.raised": {
      bump(state, "issue", event.issueId);
      const c = must(state.candidates[event.candidateId], `candidate ${event.candidateId}`);
      state.issues[event.issueId] = {
        id: event.issueId,
        candidateId: event.candidateId,
        severity: event.severity,
        location: event.location,
        summary: event.summary,
        by: event.by,
        status: "open",
        disposition: null,
        dispositionReason: null,
      };
      if (!c.issueIds.includes(event.issueId)) c.issueIds.push(event.issueId);
      return state;
    }
    case "issue.resolved": {
      const i = must(state.issues[event.issueId], `issue ${event.issueId}`);
      i.status = "resolved";
      i.disposition = event.disposition;
      i.dispositionReason = event.reason;
      return state;
    }
    case "computation.recorded":
      bump(state, "computation", event.compId);
      state.computations[event.compId] = {
        id: event.compId,
        taskId: event.taskId,
        entry: event.entry,
        inputsHash: event.inputsHash,
        outputHash: event.outputHash,
        exitCode: event.exitCode ?? null,
        stderr: event.stderr ?? "",
        repairedReason: null,
        reproduced: null,
      };
      return state;
    case "computation.baselineRepaired": {
      const x = must(state.computations[event.compId], `computation ${event.compId}`);
      x.inputsHash = event.inputsHash;
      x.outputHash = event.outputHash;
      x.exitCode = event.exitCode;
      x.stderr = event.stderr;
      x.repairedReason = event.reason;
      x.reproduced = null;
      return state;
    }
    case "computation.reproduced": {
      const x = must(state.computations[event.compId], `computation ${event.compId}`);
      x.reproduced = {
        match: event.match,
        outputHash: event.outputHash,
        exitCode: event.exitCode ?? null,
        stderr: event.stderr ?? "",
      };
      return state;
    }
    case "acceptance.evaluated": {
      const c = must(state.candidates[event.candidateId], `candidate ${event.candidateId}`);
      c.acceptance = { passed: event.passed, failing: event.failing };
      return state;
    }

    // ---- memory ----------------------------------------------------------
    case "memory.cardProposed":
      bump(state, "card", event.cardId);
      state.cards[event.cardId] = {
        id: event.cardId,
        card: event.card,
        proposedBy: event.by,
        status: "PENDING",
        admissionReason: null,
      };
      return state;
    case "memory.cardAdmitted": {
      const m = must(state.cards[event.cardId], `card ${event.cardId}`);
      m.status = event.status;
      m.admissionReason = event.reason;
      return state;
    }
    case "memory.cardStatus": {
      const m = must(state.cards[event.cardId], `card ${event.cardId}`);
      m.status = event.to;
      m.admissionReason = event.reason;
      return state;
    }
    case "memory.recall":
      return state; // logged for audit; per-task recall detail lives in task files
    case "capsule.updated":
      return state; // capsule content lives on disk; the event is a marker
    case "manager.noteRecorded": {
      const note = {
        waveId: event.waveId,
        path: event.path,
        abstract: event.abstract ?? "",
        markdown: event.markdown,
        source: event.source,
        recordedAtSeq: event.seq,
        recordedAt: event.ts,
      };
      // A call may be retried after a process crash. Keep one authoritative
      // snapshot per round or numbered checkpoint revision.
      const existing = state.researchManagerNotes.findIndex((entry) => entry.waveId === event.waveId);
      if (existing === -1) state.researchManagerNotes.push(note);
      else state.researchManagerNotes[existing] = note;
      return state;
    }
    case "summary.recorded": {
      const view = {
        waveId: event.waveId,
        path: event.path,
        abstract: event.abstract,
        markdown: event.markdown,
        changed: event.changed,
        reason: event.reason,
        source: event.source,
        recordedAtSeq: event.seq,
        recordedAt: event.ts,
      };
      const existing = state.mathematicalViews.findIndex((entry) => entry.waveId === event.waveId);
      if (existing === -1) state.mathematicalViews.push(view);
      else state.mathematicalViews[existing] = view;
      if (event.usage) state.budget.plannerSpentTokens += usageSpend(event.usage);
      return state;
    }
    case "wave.summaryReviewed": {
      const wave = must(state.waves[event.waveId], `wave ${event.waveId}`);
      wave.summaryReviewed = true;
      return state;
    }
    case "resolution.recorded": {
      const w = must(state.waves[event.waveId], `wave ${event.waveId}`);
      w.resolutionPath = event.path;
      return state;
    }
    case "digest.updated":
      return state;

    default: {
      // Exhaustiveness: if a new event type is added to the union, this fails
      // to compile until the reducer handles it.
      const exhausted: never = event;
      throw new Error(`unhandled event ${(exhausted as { type: string }).type}`);
    }
  }
}

export function replay(state: ProjectState, events: Iterable<Event>): ProjectState {
  for (const e of events) applyEvent(state, e);
  return state;
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`reducer: unknown ${what}`);
  return value;
}

function bump(state: ProjectState, kind: IdKind, id: string): void {
  const n = idNumber(kind, id);
  if (n === null) throw new Error(`malformed ${kind} id: ${id}`);
  const current = state.counters[kind] ?? 0;
  if (n > current) state.counters[kind] = n;
}
