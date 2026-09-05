import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CardStore, FileMemoryBackend } from "../src/memory/cardStore.js";
import { RecurrentMemoryBackend } from "../src/memory/recurrent.js";
import { MemoryService } from "../src/memory/service.js";
import type { MemoryCard, RecallRecord } from "../src/memory/types.js";
import { defaultTrajectoryConfig, initialState } from "@inventio/schema";

function card(partial: Partial<MemoryCard> & { id: string }): MemoryCard {
  return {
    type: "LEMMA",
    status: "VERIFIED",
    title: `title of ${partial.id}`,
    abstract: `abstract of ${partial.id}`,
    content: `body of ${partial.id}`,
    tags: [],
    provenance: "problem.md",
    sourceArtifact: null,
    dependsOn: [],
    ...partial,
  };
}

const CARDS: MemoryCard[] = [
  card({
    id: "M001",
    type: "LEMMA",
    status: "VERIFIED",
    title: "Cohomology vanishing for ample bundles",
    abstract: "H^1 vanishes for an ample line bundle on a smooth projective surface.",
    content: "## M001\n\nFull statement and proof sketch.\n",
    tags: ["vanishing", "surfaces"],
    provenance: "A001 §2, checked by R001",
    sourceArtifact: "A001",
    dependsOn: ["M002"],
  }),
  card({
    id: "M002",
    type: "DEFINITION",
    status: "VERIFIED",
    title: "Ample line bundle",
    abstract: "Standard definition used throughout.",
    content: "A line bundle L is ample if ...\n",
    tags: ["definitions"],
    provenance: "problem.md",
  }),
  card({
    id: "M003",
    type: "ATTEMPT-SUMMARY",
    status: "PROPOSED",
    title: "Degeneration attempt",
    abstract: "Degeneration to the normal cone; the cohomology bound stayed unclear.",
    content: "Attempt notes.\n",
    tags: ["surfaces"],
    provenance: "A002 §4",
    sourceArtifact: "A002",
  }),
  card({
    id: "M004",
    type: "COUNTEREXAMPLE",
    status: "QUARANTINED",
    title: "Bogus counterexample",
    abstract: "Claimed cohomology counterexample; refuted at I003.",
    content: "Do not trust this.\n",
    tags: ["surfaces"],
    provenance: "E001",
  }),
  card({
    id: "M005",
    type: "LEMMA",
    status: "SUPERSEDED",
    title: "Retired cohomology duplicate",
    abstract: "An older, less precise version of M001.",
    content: "Retained only for provenance.\n",
    tags: ["surfaces"],
    provenance: "condensed into M001",
  }),
];

const LONG_ARTIFACT = "x".repeat(9000);

function makeProject(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "collq-memory-"));
  const cardsDir = path.join(dir, "memory", "cards");
  const store = new CardStore(cardsDir);
  for (const c of CARDS) store.write(c);
  mkdirSync(path.join(dir, "artifacts", "attempts"), { recursive: true });
  writeFileSync(path.join(dir, "artifacts", "attempts", "A001.md"), "# A001\n\nThe full attempt text.\n");
  writeFileSync(path.join(dir, "artifacts", "attempts", "A002.md"), LONG_ARTIFACT);
  mkdirSync(path.join(dir, "intake"), { recursive: true });
  writeFileSync(path.join(dir, "intake", "original-objective.md"), "Use DNC master-space localization.\n");
  writeFileSync(path.join(dir, "intake", "sources.json"), JSON.stringify([{
    id: "S001",
    kind: "objective",
    title: "Original objective",
    relativePath: "intake/original-objective.md",
    size: 35,
    sha256: "0".repeat(64),
    abstract: "The objective specifies DNC master-space localization.",
    excerptMarkdown: "**Method.** Use localization on the DNC master space.",
  }]));
  return dir;
}

describe("CardStore", () => {
  it("round-trips cards through the frontmatter format", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "collq-cards-"));
    const store = new CardStore(path.join(dir, "cards"));
    const a = CARDS[0]!;
    const b = CARDS[1]!;
    store.write(a);
    store.write(b);

    const all = store.readAll();
    expect(all).toHaveLength(2);
    expect(all[0]).toEqual(a);
    expect(all[1]).toEqual(b);
    expect(store.get("M001")).toEqual(a);
    expect(store.get("M999")).toBeNull();
  });

  it("writes atomically and leaves no temp files behind", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "collq-cards-"));
    const cardsDir = path.join(dir, "cards");
    const store = new CardStore(cardsDir);
    for (const c of CARDS) store.write(c);
    const names = readdirSync(cardsDir).sort();
    expect(names).toEqual(["M001.md", "M002.md", "M003.md", "M004.md", "M005.md"]);
  });

  it("skips unparseable and unknown files without throwing", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "collq-cards-"));
    const cardsDir = path.join(dir, "cards");
    const store = new CardStore(cardsDir);
    store.write(CARDS[0]!);
    writeFileSync(path.join(cardsDir, "M900.md"), "no frontmatter here\n");
    writeFileSync(path.join(cardsDir, "M901.md"), "---\nid: M901\ntype: NONSENSE\nstatus: VERIFIED\ntitle: x\ntags: []\nprovenance: p\nsourceArtifact: \ndependsOn: []\nabstract: a\n---\nbody\n");
    writeFileSync(path.join(cardsDir, "README.txt"), "not a card");

    const all = store.readAll();
    expect(all.map((c) => c.id)).toEqual(["M001"]);
    expect(new CardStore(path.join(dir, "does-not-exist")).readAll()).toEqual([]);
  });
});

describe("FileMemoryBackend", () => {
  const dir = makeProject();
  const recalls: RecallRecord[] = [];
  const backend = new FileMemoryBackend(dir, (r) => recalls.push(r));

  it("ranks title hits above abstract and tag hits", () => {
    const rows = backend.searchCards({ query: "cohomology" });
    expect(rows.map((r) => r.id)).toEqual(["M001", "M003", "M004"]);
  });

  it("filters by type, status and tags", () => {
    expect(backend.searchCards({ query: "", types: ["DEFINITION"] }).map((r) => r.id)).toEqual(["M002"]);
    expect(backend.searchCards({ query: "", statuses: ["PROPOSED"] }).map((r) => r.id)).toEqual(["M003"]);
    expect(backend.searchCards({ query: "", tags: ["surfaces"] }).map((r) => r.id)).toEqual([
      "M001",
      "M003",
      "M004",
    ]);
    expect(backend.searchCards({ query: "", tags: ["nope"] })).toEqual([]);
  });

  it("searches the working library by default and the retired archive explicitly", () => {
    expect(backend.searchCards({ query: "retired" })).toEqual([]);
    expect(
      backend.searchCards({ query: "retired", statuses: ["SUPERSEDED"] }).map((row) => row.id),
    ).toEqual(["M005"]);
  });

  it("ranks promising directions before otherwise equal active cards", () => {
    const promisingDir = mkdtempSync(path.join(os.tmpdir(), "collq-promising-"));
    const store = new CardStore(path.join(promisingDir, "memory", "cards"));
    store.write(card({ id: "M010", title: "Same route", abstract: "Same conclusion." }));
    store.write(card({ id: "M011", title: "Same route", abstract: "Same conclusion.", tags: ["promising"] }));
    const ranked = new FileMemoryBackend(promisingDir, () => undefined);
    expect(ranked.searchCards({ query: "same" }).map((row) => row.id)).toEqual(["M011", "M010"]);
  });

  it("keeps QUARANTINED cards visible in search", () => {
    const rows = backend.searchCards({ query: "bogus" });
    expect(rows.map((r) => r.id)).toEqual(["M004"]);
    expect(rows[0]!.status).toBe("QUARANTINED");
  });

  it("caps the limit at 20 and defaults to 5", () => {
    const many = mkdtempSync(path.join(os.tmpdir(), "collq-many-"));
    const store = new CardStore(path.join(many, "memory", "cards"));
    for (let i = 1; i <= 25; i++) store.write(card({ id: `M${String(i).padStart(3, "0")}` }));
    const b = new FileMemoryBackend(many, () => undefined);
    expect(b.searchCards({ query: "" })).toHaveLength(5);
    expect(b.searchCards({ query: "", limit: 100 })).toHaveLength(20);
    expect(b.searchCards({ query: "", limit: 3 })).toHaveLength(3);
  });

  it("reads the linked artifact excerpt, truncated to 8000 chars", () => {
    const m001 = backend.getCards(["M001"])[0]!;
    expect(backend.readLinkedArtifact(m001)).toContain("The full attempt text.");

    const m003 = backend.getCards(["M003"])[0]!;
    expect(backend.readLinkedArtifact(m003)).toHaveLength(8000);

    const m002 = backend.getCards(["M002"])[0]!;
    expect(backend.readLinkedArtifact(m002)).toBeNull();
    expect(backend.readLinkedArtifact({ ...m002, sourceArtifact: "A999" })).toBeNull();
  });

  it("silently omits missing ids from getCards", () => {
    expect(backend.getCards(["M001", "M404", "M002"]).map((c) => c.id)).toEqual(["M001", "M002"]);
  });
});

interface ToolText {
  content: { type: string; text?: string }[];
  isError?: boolean;
}

function textOf(result: unknown): string {
  const r = result as ToolText;
  return r.content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

describe("MemoryService over HTTP", () => {
  const dir = makeProject();
  const recalls: RecallRecord[] = [];
  const backend = new FileMemoryBackend(dir, (r) => recalls.push(r));
  const service = new MemoryService({ port: 0 });
  let solverToken = "";
  let reviewerToken = "";
  let managerToken = "";
  let trajectorySolverToken = "";
  const clients: Client[] = [];

  beforeAll(async () => {
    await service.start();
    service.registerProject("proj", backend);
    const trajectoryState = initialState();
    trajectoryState.config = defaultTrajectoryConfig();
    const trajectoryBackend = new FileMemoryBackend(
      dir,
      (r) => recalls.push(r),
      {
        getState: () => trajectoryState,
        recordMilestone: () => ({ milestoneId: "MS001" }),
        flagFact: () => ({ correctionClaimId: "K001" }),
      },
    );
    service.registerProject("trajectory-proj", trajectoryBackend);
    solverToken = service.mintToken({ slug: "proj", taskId: "T001", role: "solver", waveId: "W001" });
    reviewerToken = service.mintToken({ slug: "proj", taskId: "T002", role: "reviewer", waveId: "W001" });
    managerToken = service.mintToken({ slug: "proj", taskId: "DEC001", role: "research_manager", waveId: "between-rounds" });
    trajectorySolverToken = service.mintToken({ slug: "trajectory-proj", taskId: "T101", role: "solver", waveId: "W001" });
  });

  afterAll(async () => {
    for (const c of clients) await c.close().catch(() => undefined);
    await service.stop();
  });

  async function connect(token: string | null): Promise<Client> {
    const client = new Client({ name: "memory-test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(service.url), {
      requestInit: token === null ? {} : { headers: { Authorization: `Bearer ${token}` } },
    });
    // exactOptionalPropertyTypes vs. the SDK's Transport interface: same shape, stricter check.
    await client.connect(transport as unknown as Parameters<Client["connect"]>[0]);
    clients.push(client);
    return client;
  }

  it("enforces a blind mathematical-only view through every exposed MCP tool", async () => {
    const state = initialState();
    state.research.versions["B001.v1"] = { id: "B001.v1", resultId: "B001", version: 1, parentVersionId: null, sessionId: "S001", roundId: "W001", kind: "CALCULATION", title: "Boundary identity", statement: "D = 10/3", proofMarkdown: "Summing the two boundary terms gives 10/3.", dependencies: [], sourceIds: [], relationToGoal: "PARTIAL", attachments: [], hash: "a".repeat(64) };
    state.research.versionOrder.push("B001.v1");
    state.research.notes.N001 = { kind: "note.recorded", id: "N001", sessionId: "S001", roundId: "W001", name: "notes/old-opinion.md", hash: "b".repeat(64), markdown: "SECRET previous verdict and author confidence" };
    const backend = new RecurrentMemoryBackend(dir, () => undefined, () => state, () => ({ notes: [], results: [] }), () => undefined);
    service.registerProject("blind-research", backend);
    const auditor = await connect(service.mintToken({ slug: "blind-research", taskId: "S002", role: "auditor", waveId: "W002", allowedVersionIds: ["B001.v1"] }));
    expect((await auditor.listTools()).tools.map(t => t.name).sort()).toEqual(["audit_assess", "research_open", "research_search", "source_list", "source_open"].sort());
    const opened = textOf(await auditor.callTool({ name: "research_open", arguments: { id: "B001.v1", start: 0, maxCharacters: 30000 } }));
    expect(opened).toContain("D = 10/3");
    expect(opened).not.toMatch(/SECRET|Current qualification|S001/);
    expect(textOf(await auditor.callTool({ name: "research_search", arguments: { query: "SECRET", limit: 10 } }))).not.toContain("N001");
    expect(textOf(await auditor.callTool({ name: "research_open", arguments: { id: "N001", start: 0, maxCharacters: 30000 } }))).not.toContain("SECRET");
    for (const name of ["memory_search", "writeup_open", "knowledge_open", "research_checkpoint"]) {
      expect((await auditor.callTool({ name, arguments: { query: "", results: [] } }) as ToolText).isError).toBe(true);
    }
    const solver = await connect(service.mintToken({ slug: "blind-research", taskId: "S001", role: "solver", waveId: "W002" }));
    expect(textOf(await solver.callTool({ name: "research_open", arguments: { id: "N001", start: 0, maxCharacters: 30000 } }))).toContain("SECRET");
    expect((await solver.callTool({ name: "audit_assess", arguments: {} }) as ToolText).isError).toBe(true);
  });

  it("lists memory and original-source tools", async () => {
    const client = await connect(solverToken);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "memory_expand",
      "memory_search",
      "source_list",
      "source_open",
    ]);
    const search = tools.find((t) => t.name === "memory_search")!;
    expect(search.inputSchema.required).toEqual(["query"]);
  });

  it("lets only the Research Manager list and open original intake text", async () => {
    const solver = await connect(solverToken);
    const refused = await solver.callTool({ name: "source_list", arguments: { query: "" } }) as ToolText;
    expect(refused.isError).toBe(true);

    const manager = await connect(managerToken);
    const listed = textOf(await manager.callTool({ name: "source_list", arguments: { query: "DNC" } }));
    expect(listed).toContain("S001 [objective]");
    const opened = textOf(await manager.callTool({
      name: "source_open",
      arguments: { sourceId: "S001", reason: "check the intended method" },
    }));
    expect(opened).toContain("Use DNC master-space localization.");
    expect(recalls.at(-1)).toMatchObject({
      taskId: "DEC001",
      role: "research_manager",
      op: "source_open",
      returnedIds: ["S001"],
    });
  });

  it("gives v2 trajectories the research-library tools and retained intake sources", async () => {
    const solver = await connect(trajectorySolverToken);
    const { tools } = await solver.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
      "knowledge_search",
      "knowledge_open",
      "writeup_search",
      "writeup_open",
      "mark_milestone",
      "flag_fact",
      "source_list",
      "source_open",
    ]));
    const listed = textOf(await solver.callTool({
      name: "source_list",
      arguments: { query: "DNC" },
    }));
    expect(listed).toContain("S001 [objective]");
    const opened = textOf(await solver.callTool({
      name: "source_open",
      arguments: { sourceId: "S001", reason: "recover the owner's precise meaning of DNC" },
    }));
    expect(opened).toContain("Use DNC master-space localization.");
    expect(recalls.at(-1)).toMatchObject({
      taskId: "T101",
      role: "solver",
      op: "source_open",
      returnedIds: ["S001"],
    });
  });

  it("searches, flags QUARANTINED rows and records the recall", async () => {
    const client = await connect(solverToken);
    const before = recalls.length;
    const out = textOf(await client.callTool({ name: "memory_search", arguments: { query: "cohomology" } }));
    const lines = out.split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("M001 [LEMMA/VERIFIED]");
    expect(lines[0]).toContain("provenance: A001 §2, checked by R001");
    expect(lines[2]).toContain("⚠ QUARANTINED — warning only, not usable as fact:");

    const rec = recalls[recalls.length - 1]!;
    expect(recalls.length).toBe(before + 1);
    expect(rec).toMatchObject({ taskId: "T001", role: "solver", op: "search", refusedIds: [] });
    expect(rec.returnedIds).toEqual(["M001", "M003", "M004"]);
    expect(JSON.parse(rec.args)).toEqual({ query: "cohomology" });
  });

  it("reports an empty result plainly", async () => {
    const client = await connect(solverToken);
    const out = textOf(await client.callTool({ name: "memory_search", arguments: { query: "zzzz-no-such-thing" } }));
    expect(out).toBe("No cards match.");
  });

  it("expands a card with its linked artifact", async () => {
    const client = await connect(solverToken);
    const out = textOf(
      await client.callTool({
        name: "memory_expand",
        arguments: { cardIds: ["M001", "M404"], reason: "need the exact vanishing hypothesis" },
      }),
    );
    expect(out).toContain("=== M001 [LEMMA/VERIFIED] Cohomology vanishing for ample bundles ===");
    expect(out).toContain("dependsOn: M002");
    expect(out).toContain("Full statement and proof sketch.");
    expect(out).toContain("--- linked artifact (A001) ---");
    expect(out).toContain("The full attempt text.");
    expect(out).toContain("UNKNOWN M404");

    const rec = recalls[recalls.length - 1]!;
    expect(rec).toMatchObject({ taskId: "T001", role: "solver", op: "expand", refusedIds: [] });
    expect(rec.returnedIds).toEqual(["M001"]);
  });

  it("refuses to expand a QUARANTINED card and logs the refusal", async () => {
    const client = await connect(solverToken);
    const out = textOf(
      await client.callTool({
        name: "memory_expand",
        arguments: { cardIds: ["M004"], reason: "curious about the counterexample" },
      }),
    );
    expect(out).toContain("REFUSED M004:");
    expect(out).toContain("QUARANTINED");
    expect(out).not.toContain("Do not trust this.");

    const rec = recalls[recalls.length - 1]!;
    expect(rec.refusedIds).toEqual(["M004"]);
    expect(rec.returnedIds).toEqual([]);
  });

  it("shows a reviewer only VERIFIED cards and refuses PROPOSED expansion", async () => {
    const client = await connect(reviewerToken);
    const out = textOf(await client.callTool({ name: "memory_search", arguments: { query: "" } }));
    const ids = out.split("\n").map((l) => l.slice(0, 4));
    expect(ids).toEqual(["M001", "M002"]);

    const expanded = textOf(
      await client.callTool({
        name: "memory_expand",
        arguments: { cardIds: ["M003"], reason: "auditing the attempt" },
      }),
    );
    expect(expanded).toContain("REFUSED M003:");
    expect(expanded).toContain("VERIFIED");
    const rec = recalls[recalls.length - 1]!;
    expect(rec).toMatchObject({ taskId: "T002", role: "reviewer", refusedIds: ["M003"] });
  });

  it("rejects an empty reason without recording a recall", async () => {
    const client = await connect(solverToken);
    const before = recalls.length;
    const result = (await client.callTool({
      name: "memory_expand",
      arguments: { cardIds: ["M001"], reason: "   " },
    })) as ToolText;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("reason is required");
    expect(recalls.length).toBe(before);
  });

  it("rejects malformed search arguments without recording a recall", async () => {
    const client = await connect(solverToken);
    const before = recalls.length;
    const result = (await client.callTool({
      name: "memory_search",
      arguments: { query: "x", limit: "lots" },
    })) as ToolText;
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("limit must be a number");
    expect(recalls.length).toBe(before);
  });

  it("refuses a missing or unknown bearer token", async () => {
    await expect(connect(null)).rejects.toThrow();
    await expect(connect("deadbeefdeadbeefdeadbeefdeadbeef")).rejects.toThrow();
  });

  it("refuses a revoked token and an unregistered project", async () => {
    const token = service.mintToken({ slug: "proj", taskId: "T003", role: "solver", waveId: "W001" });
    const client = await connect(token);
    expect(textOf(await client.callTool({ name: "memory_search", arguments: { query: "" } }))).toContain("M001");

    service.revokeToken(token);
    await expect(client.callTool({ name: "memory_search", arguments: { query: "" } })).rejects.toThrow();

    const orphan = service.mintToken({ slug: "other-project", taskId: "T004", role: "solver", waveId: "W001" });
    await expect(connect(orphan)).rejects.toThrow();
  });
});
