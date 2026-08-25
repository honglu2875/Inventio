import { describe, expect, it } from "vitest";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  defaultConfig,
  initialState,
  validateActionEnvelope,
  type ActionEnvelope,
  type PlannedTask,
} from "@inventio/schema";
import { EventLog } from "../src/store/eventLog.js";
import { createProjectDirs, listProjectSlugs, projectPaths, writeFileAtomic, writeProjectFile, readProjectFile, defaultProjectFile } from "../src/store/projectStore.js";
import { WorkerPool } from "../src/engine/pool.js";
import { buildDocket } from "../src/engine/docket.js";
import { renderAgentsMd } from "../src/prompts/workers.js";
import { TEX_LAYOUT_GUIDANCE } from "../src/prompts/shared.js";
import { composePacket, SealViolationError, type PacketSpec } from "../src/engine/packets.js";
import {
  curationPacketFiles,
  decisionPacketFiles,
  finalPacketFiles,
  intakePacketFiles,
} from "../src/prompts/researchManager.js";
import { RESEARCH_MANAGER_EXAMPLES } from "../src/prompts/managerExamples.js";
import { validateAction } from "../src/engine/validate.js";

const tmp = () => mkdtempSync(path.join(os.tmpdir(), "collq-core-"));

describe("EventLog", () => {
  it("appends with seq/ts, fsyncs, and replays identically after reopen", () => {
    const file = path.join(tmp(), "events.jsonl");
    const log = EventLog.open(file);
    const e1 = log.append({ type: "project.created", slug: "s-a", title: "T", statement: "P", config: defaultConfig() });
    const e2 = log.append({ type: "phase.changed", from: "CREATED", to: "INTAKE", reason: "start" });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    log.close();

    const reopened = EventLog.open(file);
    expect(reopened.events.length).toBe(2);
    expect(reopened.events[1]!.type).toBe("phase.changed");
    const e3 = reopened.append({ type: "project.paused", by: "human" });
    expect(e3.seq).toBe(3);
    reopened.close();
  });

  it("drops a torn tail line but rejects mid-file corruption", () => {
    const dir = tmp();
    const file = path.join(dir, "events.jsonl");
    const log = EventLog.open(file);
    log.append({ type: "project.created", slug: "s-a", title: "T", statement: "P", config: defaultConfig() });
    log.close();
    appendFileSync(file, '{"seq":2,"ts":"x","type":"project.pau'); // torn
    const reopened = EventLog.open(file);
    expect(reopened.events.length).toBe(1);
    // appending after a torn tail keeps seq continuity
    const e = reopened.append({ type: "project.paused", by: "human" });
    expect(e.seq).toBe(2);
    reopened.close();

    const file2 = path.join(dir, "corrupt.jsonl");
    writeFileSync(file2, 'garbage\n{"seq":1}\n');
    expect(() => EventLog.open(file2)).toThrow(/corrupt/);
  });

  it("refuses invalid events and seq gaps", () => {
    const file = path.join(tmp(), "events.jsonl");
    const log = EventLog.open(file);
    expect(() => log.append({ type: "phase.changed", from: "NOPE", to: "INTAKE", reason: "" } as never)).toThrow(/invalid/);
    log.close();
    const file2 = path.join(tmp(), "gap.jsonl");
    writeFileSync(file2, '{"seq":1,"ts":"t","type":"project.paused","by":"h"}\n{"seq":3,"ts":"t","type":"project.resumed","by":"h"}\n');
    expect(() => EventLog.open(file2)).toThrow(/seq gap/);
  });
});

describe("projectStore", () => {
  it("creates layout, writes project file atomically, lists slugs", () => {
    const root = tmp();
    const p = projectPaths(root, "my-problem");
    createProjectDirs(p);
    writeProjectFile(p, defaultProjectFile("my-problem", "My problem", defaultConfig()));
    expect(readProjectFile(p).title).toBe("My problem");
    expect(existsSync(path.join(p.artifactsDir, "attempts"))).toBe(true);
    expect(listProjectSlugs(root)).toEqual(["my-problem"]);
    // no temp droppings
    expect(readdirSync(p.dir).filter((f) => f.startsWith(".tmp-"))).toEqual([]);
    expect(() => projectPaths(root, "Bad Slug")).toThrow(/slug/);
  });

  it("writeFileAtomic replaces content atomically", () => {
    const dir = tmp();
    const f = path.join(dir, "a", "x.md");
    writeFileAtomic(f, "one");
    writeFileAtomic(f, "two");
    expect(readFileSync(f, "utf8")).toBe("two");
  });
});

describe("WorkerPool", () => {
  it("caps concurrency and drains the queue", async () => {
    const pool = new WorkerPool(2);
    let peak = 0;
    let current = 0;
    const job = () =>
      pool.run(async () => {
        current += 1;
        peak = Math.max(peak, current);
        await new Promise((r) => setTimeout(r, 30));
        current -= 1;
      });
    await Promise.all([job(), job(), job(), job(), job()]);
    expect(peak).toBe(2);
  });
});

describe("buildDocket", () => {
  it("deduplicates claims, neutralizes authors, and reports outcomes", () => {
    const memoBase = {
      summary: "",
      newClaims: [],
      issues: [],
      obligations: [],
      deadEnds: [],
      proposedCards: [],
      computations: [],
      budgetReport: "",
    };
    const md = buildDocket("W002", "Bottleneck lemma", [
      {
        taskId: "T004",
        role: "solver",
        methodTag: "induction",
        status: "completed",
        headline: "UNCERTAIN",
        memo: {
          ...memoBase,
          summary: "Reduced to parity lemma",
          newClaims: [{ statement: "The parity lemma holds for odd n.", evidence: "proved-in-artifact", where: "§2" }],
          obligations: ["Even case of the parity lemma"],
          budgetReport: "80% used",
        },
        interruptReason: null,
        error: null,
      },
      {
        taskId: "T005",
        role: "explorer",
        methodTag: "small-cases",
        status: "completed",
        headline: "UNCERTAIN",
        memo: {
          ...memoBase,
          newClaims: [{ statement: "the parity  lemma holds for odd n.", evidence: "computation", where: "table 1" }],
          deadEnds: ["Naive bound fails for n=7"],
        },
        interruptReason: null,
        error: null,
      },
      {
        taskId: "T006",
        role: "solver",
        methodTag: "contradiction",
        status: "interrupted",
        headline: null,
        memo: null,
        interruptReason: "budget",
        error: null,
      },
    ]);
    // dedup: the two textually-different but equivalent claims collapse to one line
    expect(md.match(/parity lemma holds for odd n/gi)?.length).toBe(1);
    expect(md).toContain("a solver");
    expect(md).toContain("an explorer");
    expect(md).toContain("INTERRUPTED (budget)");
    expect(md).toContain("Naive bound fails for n=7");
    expect(md).toContain("Even case of the parity lemma");
    // task ids present only in outcomes section for cross-exam targeting
    expect(md).toContain("T006");
  });
});

describe("academic model-facing language", () => {
  const operationalJargon =
    /\b(packet|provenance|conductor|lineage|ledger|disposition|digest|sealed|docket|recall|curation|capsule|unblock|gate|gated|directive|reconciliation|admission|promotion|quarantined?|triage|debt|backlog|queue|freeze|frozen|terminal|mechanical|audit|author-neutral|materialize|durable|roster|manifest|grant|jail|hermetic|sandbox|dispatch|interrupt|kill|salvage|telemetry|lifecycle|checkpoint|certificate)\b/i;
  const readyState = () => {
    const state = initialState();
    state.config = defaultConfig();
    state.budget.totalTokens = state.config.budget.totalTokens;
    return state;
  };

  it("keeps operational vocabulary out of mathematical guidance", () => {
    const state = readyState();
    const decision = decisionPacketFiles(state, {
      digest: "Earlier summary",
      docket: "Latest findings",
      resolution: "Earlier round",
      previousReport: "Earlier report",
    });
    const assessment = curationPacketFiles(
      state,
      "W001",
      "Round findings",
      "{}",
      { solver: "Solver notes", explorer: "Explorer notes", reviewer: "Referee notes" },
      "Project summary",
    );
    const final = finalPacketFiles(state, "UNCERTAIN", null, "Project summary");
    const intake = intakePacketFiles("Prove P.", "Earlier ideas.");

    for (const contract of [
      decision["AGENTS.md"]!,
      assessment["AGENTS.md"]!,
      final["AGENTS.md"]!,
      intake["AGENTS.md"]!,
    ]) {
      const mathematicalGuidance = contract.split("## Internal response format")[0]!;
      expect(mathematicalGuidance).not.toMatch(operationalJargon);
    }
  });

  it("gives copied research materials academic filenames", () => {
    const state = readyState();
    const decision = decisionPacketFiles(state, {
      digest: "Earlier summary",
      docket: "Latest findings",
      resolution: "Earlier round",
      previousReport: "Earlier report",
    });
    expect(Object.keys(decision)).toEqual(
      expect.arrayContaining([
        "current-record.md",
        "project-summary.md",
        "latest-round-findings.md",
        "previous-round-summary.md",
        "earlier-report.md",
      ]),
    );
    for (const oldName of ["ledger.md", "digest.md", "docket.md", "round-resolution.md"]) {
      expect(Object.keys(decision)).not.toContain(oldName);
    }
  });

  it("teaches every mathematical author not to span alignment rows with scalable delimiters", () => {
    const state = readyState();
    const decision = decisionPacketFiles(state, {
      digest: null,
      docket: null,
      resolution: null,
      previousReport: null,
    });
    const assessment = curationPacketFiles(
      state,
      "W001",
      "Round findings",
      "{}",
      { solver: "", explorer: "", reviewer: "" },
      null,
    );
    const final = finalPacketFiles(state, "UNCERTAIN", null, null);
    const intake = intakePacketFiles("Prove P.", "");
    const worker = renderAgentsMd(
      {
        taskId: "T001",
        role: "solver",
        methodTag: "direct",
        direction: "Prove P.",
        briefMarkdown: "Try a direct proof.",
        tokenBudget: 60_000,
        computation: false,
        reviewOf: null,
        reviewScope: null,
        reviewQuestions: [],
        webSearch: false,
        hasMemoryIndex: false,
        memoryToolsAvailable: false,
      },
      ["research-question.md"],
    );

    for (const contract of [
      decision["AGENTS.md"]!,
      assessment["AGENTS.md"]!,
      final["AGENTS.md"]!,
      intake["AGENTS.md"]!,
      worker,
    ]) {
      expect(contract).toContain(TEX_LAYOUT_GUIDANCE);
      expect(contract).toContain("\\left and \\right");
      expect(contract).toContain("\\\\ row boundary");
    }
  });

  it("carries the Manager's current view into later decisions and round assessments", () => {
    const state = readyState();
    state.researchManagerNotes.push({
      waveId: "W003",
      path: "artifacts/manager-notes/W003.md",
      abstract: "The deformation route has one remaining lemma.",
      markdown: "The deformation route now reduces to one specialization lemma.",
      source: "research_manager",
      recordedAtSeq: 40,
      recordedAt: "2026-08-25T00:00:00.000Z",
    });
    const decision = decisionPacketFiles(state, {
      digest: null,
      docket: null,
      resolution: null,
      previousReport: null,
    });
    const assessment = curationPacketFiles(
      state,
      "W004",
      "Round findings",
      "{}",
      { solver: "", explorer: "", reviewer: "" },
      null,
    );

    expect(decision["research-manager-current-view.md"]).toContain("specialization lemma");
    expect(assessment["research-manager-previous-view.md"]).toContain("specialization lemma");
    expect(decision["research-manager-voice-examples.md"]).toBe(RESEARCH_MANAGER_EXAMPLES);
    expect(assessment["research-manager-voice-examples.md"]).toBe(RESEARCH_MANAGER_EXAMPLES);
  });

  it("keeps owner examples canonical and marks every inferred example for review", () => {
    expect(RESEARCH_MANAGER_EXAMPLES.match(/^## OWNER EXAMPLE/gm)).toHaveLength(4);
   expect(RESEARCH_MANAGER_EXAMPLES.match(/^## DRAFT EXAMPLE — OWNER REVIEW/gm)).toHaveLength(4);
   expect(RESEARCH_MANAGER_EXAMPLES).toContain("identifies the real gap");
   expect(RESEARCH_MANAGER_EXAMPLES).not.toContain("fill in the following template");
    expect(RESEARCH_MANAGER_EXAMPLES).toContain(String.raw`$\mathbb P^1\times\mathbb P^5$`);
    expect(RESEARCH_MANAGER_EXAMPLES).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
 });

  it("distinguishes write-up, library-note, and claim IDs in next-step guidance", () => {
    const state = readyState();
    const decision = decisionPacketFiles(state, {
      digest: null,
      docket: null,
      resolution: null,
      previousReport: null,
    });
    const contract = decision["AGENTS.md"]!;
    expect(contract).toContain("grants.cardIds` contains only `M...");
    expect(contract).toContain("`K...` IDs are claim labels, not files");
    expect(contract).toMatch(/supply its\s+source write-up instead/);
  });

  it("tells the research manager that a PROVED submission failed review", () => {
    const state = readyState();
    state.activeLineageId = "C001";
    state.lineages["C001"] = {
      id: "C001",
      title: "Test direction",
      status: "active",
      abandonReason: null,
      establishedCandidateId: null,
      versionIds: ["C001.v1"],
    };
    state.artifacts["A001"] = {
      id: "A001",
      kind: "attempt",
      taskId: null,
      path: "artifacts/attempts/A001.md",
      conclusion: "PROVED",
      recordedAtSeq: 1,
    };
    state.candidates["C001.v1"] = {
      id: "C001.v1",
      lineageId: "C001",
      version: 1,
      fromArtifact: "A001",
      obligations: [],
      reviewQuestions: [],
      usedClaimIds: [],
      scope: "A partial theorem.",
      reviewIds: ["R001"],
      issueIds: [],
      acceptance: { passed: false, failing: ["one FAIL review stands"] },
    };
    state.reviews["R001"] = {
      id: "R001",
      candidateId: "C001.v1",
      verdict: "FAIL",
      issueIds: [],
      taskId: "T001",
    };

    const decision = decisionPacketFiles(state, {
      digest: null,
      docket: null,
      resolution: null,
      previousReport: null,
    });
    expect(decision["current-record.md"]).toContain("C001.v1 [FAILED REVIEW]");
    expect(decision["current-record.md"]).toContain("source author conclusion: PROVED");
    expect(decision["active-candidate.md"]).toContain("Status: FAILED REVIEW");
    expect(decision["active-candidate.md"]).toContain("not an established theorem");
  });
});

describe("research and synthesis capacity", () => {
  const assignment = (role: PlannedTask["role"], index: number): PlannedTask => ({
    role,
    methodTag: "method-" + index,
    direction: "Direction " + index,
    briefMarkdown: "Investigate mathematical question " + index + ".",
    tokenBudget: 60_000,
    computation: false,
    webSearch: false,
    reviewOf: null,
    grants: { artifactIds: [], cardIds: [], sourceMounts: [] },
  });

  const action = (tasks: PlannedTask[]): ActionEnvelope => ({
    action: "plan_wave",
    plan_wave: {
      title: "Several independent directions",
      rationale: "The directions answer different mathematical questions.",
      reserveTokens: 300_000,
      tasks,
    },
    cross_examine: null,
    freeze_candidate: null,
    assess_results: null,
    record_dispositions: null,
    abandon_lineage: null,
    raise_question: null,
    terminate: null,
  });

  const ready = () => {
    const state = initialState();
    state.config = defaultConfig();
    state.budget.totalTokens = state.config.budget.totalTokens;
    return state;
  };

  it("allows synthesis in addition to eight research assignments", () => {
    const tasks = [
      ...Array.from({ length: 8 }, (_, index) => assignment("explorer", index)),
      assignment("synthesizer", 8),
      assignment("synthesizer", 9),
    ];
    const envelope = action(tasks);
    expect(validateActionEnvelope(envelope).ok).toBe(true);
    expect(validateAction(ready(), envelope)).not.toContainEqual(
      expect.stringMatching(/at most 8 solver/),
    );
  });

  it("rejects a ninth solver, explorer, or reviewer even when synthesis is separate", () => {
    const tasks = [
      ...Array.from({ length: 9 }, (_, index) => assignment("explorer", index)),
      assignment("synthesizer", 9),
    ];
    expect(validateAction(ready(), action(tasks))).toContainEqual(
      expect.stringMatching(/at most 8 solver, explorer, or reviewer/),
    );
  });
});

describe("composePacket", () => {
  function baseSpec(dir: string): PacketSpec {
    return {
      tasksDir: path.join(dir, "tasks"),
      taskId: "T001",
      role: "solver",
      methodTag: "induction",
      direction: "Direct proof",
      briefMarkdown: "Prove it.",
      tokenBudget: 1000,
      computation: false,
      webSearch: false,
      reviewOf: null,
      reviewScope: null,
      reviewQuestions: [],
      problemMarkdown: "# Problem\nProve P.",
      capsuleMarkdown: "Capsule text",
      grantedArtifacts: [],
      grantedCards: [],
      sourceMounts: [],
      claimLedgerMarkdown: null,
      memoryIndexMarkdown: null,
      memoryToolsAvailable: true,
      sealedArtifactIds: new Set<string>(),
    };
  }

  it("builds the jail with manifest-complete AGENTS.md", () => {
    const dir = tmp();
    writeFileSync(path.join(dir, "A001.md"), "attempt body");
    const spec = {
      ...baseSpec(dir),
      grantedArtifacts: [{ id: "A001", sourcePath: path.join(dir, "A001.md") }],
      grantedCards: [{ id: "M001", markdown: "---\nprovenance: A001\nsourceArtifact: A001\n---\ncard body" }],
    };
    const { packetDir, manifest } = composePacket(spec);
    expect(manifest).toContain("problem.md");
    expect(manifest).toContain("research-question.md");
    expect(manifest).toContain(path.join("references", "write-ups", "A001.md"));
    expect(manifest).toContain(path.join("references", "library-notes", "M001.md"));
    const agents = readFileSync(path.join(packetDir, "AGENTS.md"), "utf8");
    for (const f of manifest) expect(agents).toContain(f);
    expect(agents).toContain("Mathematical role");
    expect(agents.split("## Internal response format")[0]).not.toMatch(
      /\b(packet|provenance|conductor|lineage|ledger|disposition|digest|sealed|docket|recall|curation|capsule|unblock|gate|gated|directive|reconciliation|admission|promotion|quarantined?|triage|debt|backlog|queue|freeze|frozen|terminal|mechanical|audit|author-neutral|materialize|durable|roster|manifest|grant|jail|hermetic|sandbox|dispatch|interrupt|kill|salvage|telemetry|lifecycle|checkpoint|certificate)\b/i,
    );
    expect(agents).toContain("memory_search");
    // copies, not symlinks
    expect(readFileSync(path.join(packetDir, "references", "write-ups", "A001.md"), "utf8")).toBe("attempt body");
    expect(readFileSync(path.join(packetDir, "references", "library-notes", "M001.md"), "utf8")).toContain(
      "source: A001\nsourceWriteUp: A001",
    );
  });

  it("refuses sealed current-wave grants", () => {
    const dir = tmp();
    writeFileSync(path.join(dir, "A009.md"), "sealed");
    const spec = {
      ...baseSpec(dir),
      grantedArtifacts: [{ id: "A009", sourcePath: path.join(dir, "A009.md") }],
      sealedArtifactIds: new Set(["A009"]),
    };
    expect(() => composePacket(spec)).toThrow(SealViolationError);
  });

  it("repairs legacy control corruption in packet copies without changing source evidence", () => {
    const dir = tmp();
    const legacy = "$x=" + "\f" + "rac{1}{2}, " + "\x07" + "alpha$";
    const source = path.join(dir, "A001.md");
    writeFileSync(source, legacy);
    const { packetDir } = composePacket({
      ...baseSpec(dir),
      grantedArtifacts: [{ id: "A001", sourcePath: source }],
    });
    expect(readFileSync(source, "utf8")).toBe(legacy);
    expect(readFileSync(path.join(packetDir, "references", "write-ups", "A001.md"), "utf8")).toBe(
      String.raw`$x=\frac{1}{2}, \alpha$`,
    );
  });

  it("copies source mounts with excludes and never follows symlinks", () => {
    const dir = tmp();
    const mount = path.join(dir, "lib");
    mkdirSync(path.join(mount, "src"), { recursive: true });
    mkdirSync(path.join(mount, "node_modules", "junk"), { recursive: true });
    writeFileSync(path.join(mount, "src", "good.py"), "print(1)");
    writeFileSync(path.join(mount, "node_modules", "junk", "big.js"), "x");
    symlinkSync("/etc/passwd", path.join(mount, "src", "evil-link"));
    const spec = {
      ...baseSpec(dir),
      computation: true,
      sourceMounts: [{ name: "gw-lib", sourcePath: mount }],
    };
    const { packetDir, manifest } = composePacket(spec);
    expect(manifest).toContain(path.join("references", "sources", "gw-lib", "src", "good.py"));
    expect(existsSync(path.join(packetDir, "references", "sources", "gw-lib", "node_modules"))).toBe(false);
    expect(existsSync(path.join(packetDir, "references", "sources", "gw-lib", "src", "evil-link"))).toBe(false);
    expect(existsSync(path.join(packetDir, "scratch"))).toBe(true);
  });

  // Regression for the first research run: every MCP memory call was refused
  // ("requires approval, but approval policy is never"), so the catalog now
  // travels inside the packet as a file (PROTOCOL §7 file-based protocol).
  it("writes the memory catalog into the packet and names it in AGENTS.md", () => {
    const dir = tmp();
    const spec: PacketSpec = {
      ...baseSpec(dir),
      memoryIndexMarkdown: "# Memory catalog\n\n- **M001** [VERIFIED] LEMMA — Base case",
    };
    const { packetDir, manifest } = composePacket(spec);
    expect(manifest).toContain("research-library-index.md");
    expect(readFileSync(path.join(packetDir, "research-library-index.md"), "utf8")).toContain("M001");
    const agents = readFileSync(path.join(packetDir, "AGENTS.md"), "utf8");
    expect(agents).toContain("research-library-index.md");
    expect(agents).toContain("Warnings must never be used as");
  });

  it("omits the memory section entirely when there is no catalog yet", () => {
    const { packetDir, manifest } = composePacket(baseSpec(tmp()));
    expect(manifest).not.toContain("research-library-index.md");
    expect(readFileSync(path.join(packetDir, "AGENTS.md"), "utf8")).not.toContain("research-library-index.md");
  });

  it("gives reviewers the candidate and ledger surface", () => {
    const dir = tmp();
    writeFileSync(path.join(dir, "C001.v1.md"), "candidate body");
    const spec: PacketSpec = {
      ...baseSpec(dir),
      role: "reviewer",
      reviewOf: "C001.v1",
      capsuleMarkdown: null,
      grantedArtifacts: [{ id: "C001.v1", sourcePath: path.join(dir, "C001.v1.md") }],
      claimLedgerMarkdown: "| K001 | VERIFIED |",
      memoryToolsAvailable: true,
    };
    const { packetDir, manifest } = composePacket(spec);
    expect(manifest).toContain(path.join("references", "relevant-claims.md"));
    const assignment = readFileSync(path.join(packetDir, "research-question.md"), "utf8");
    expect(assignment).toContain("independently checking candidate C001.v1");
    const agents = readFileSync(path.join(packetDir, "AGENTS.md"), "utf8");
    expect(agents).toContain("verdict");
  });
});
