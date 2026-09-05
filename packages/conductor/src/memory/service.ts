import type { RecallRecord } from "./types.js";
import { RESEARCH_TOOL_DEFINITIONS } from "../prompts/tools.js";
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { randomBytes } from "node:crypto";
import { CardStatus, CardType } from "@inventio/schema";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  StreamableHTTPServerTransport,
  type StreamableHTTPServerTransportOptions,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { MODEL_TOOL_DEFINITIONS } from "../prompts/tools.js";
import type { CardRow, MemoryBackend, MemoryCard, SearchQuery, TaskScope } from "./types.js";

/**
 * The memory service (DESIGN.md §9): an MCP streamable-HTTP server hosted by
 * the Conductor process, one endpoint (`/mcp`) for every project.
 *
 * Scope is carried by the bearer token minted at dispatch, never by tool
 * arguments — a worker cannot ask for another task's or another project's
 * memory. Visibility rules (PROTOCOL.md §7) are enforced here, not in the
 * card store: QUARANTINED material is search-visible but flagged and never
 * expandable, and a reviewer sees only VERIFIED cards.
 *
 * Transport is deliberately STATELESS: a fresh low-level `Server` +
 * `StreamableHTTPServerTransport` per POST, no sessions to leak across tasks.
 */

const MCP_PATH = "/mcp";
const SERVER_NAME = "inventio-memory";
const SERVER_VERSION = "0.1.0";
const MAX_BODY_BYTES = 1_000_000;
const QUARANTINE_MARKER = "⚠ QUARANTINED — warning only, not usable as fact:";
const TRAJECTORY_TOOL_NAMES = new Set([
  "knowledge_search",
  "knowledge_open",
  "writeup_search",
  "writeup_open",
  "mark_milestone",
  "flag_fact",
]);

interface SearchArgs {
  query: string;
  types?: CardType[];
  statuses?: CardStatus[];
  tags?: string[];
  limit?: number;
}

interface ExpandArgs {
  cardIds: string[];
  reason: string;
}

interface SourceOpenArgs {
  sourceId: string;
  start?: number;
  maxCharacters?: number;
  reason: string;
}

interface QueryArgs {
  query: string;
  limit?: number;
}

interface OpenIdsArgs {
  ids: string[];
  reason: string;
  maxCharacters?: number;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stringArray(v: unknown, field: string): Parsed<string[]> {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    return { ok: false, error: `${field} must be an array of strings` };
  }
  return { ok: true, value: v as string[] };
}

function parseSearchArgs(raw: unknown): Parsed<SearchArgs> {
  if (!isRecord(raw)) return { ok: false, error: "arguments must be an object" };
  if (typeof raw["query"] !== "string") return { ok: false, error: "query must be a string" };
  const value: SearchArgs = { query: raw["query"] };

  if (raw["types"] !== undefined) {
    const arr = stringArray(raw["types"], "types");
    if (!arr.ok) return arr;
    const bad = arr.value.filter((t) => !CardType.options.includes(t as CardType));
    if (bad.length > 0) return { ok: false, error: `unknown card type(s): ${bad.join(", ")}` };
    value.types = arr.value as CardType[];
  }
  if (raw["statuses"] !== undefined) {
    const arr = stringArray(raw["statuses"], "statuses");
    if (!arr.ok) return arr;
    const bad = arr.value.filter((s) => !CardStatus.options.includes(s as CardStatus));
    if (bad.length > 0) return { ok: false, error: `unknown card status(es): ${bad.join(", ")}` };
    value.statuses = arr.value as CardStatus[];
  }
  if (raw["tags"] !== undefined) {
    const arr = stringArray(raw["tags"], "tags");
    if (!arr.ok) return arr;
    value.tags = arr.value;
  }
  if (raw["limit"] !== undefined) {
    const limit = raw["limit"];
    if (typeof limit !== "number" || !Number.isFinite(limit)) {
      return { ok: false, error: "limit must be a number" };
    }
    value.limit = limit;
  }
  return { ok: true, value };
}

function parseExpandArgs(raw: unknown): Parsed<ExpandArgs> {
  if (!isRecord(raw)) return { ok: false, error: "arguments must be an object" };
  const ids = stringArray(raw["cardIds"], "cardIds");
  if (!ids.ok) return ids;
  const reason = raw["reason"];
  if (typeof reason !== "string" || reason.trim() === "") {
    return { ok: false, error: "reason is required and must be a non-empty string" };
  }
  return { ok: true, value: { cardIds: ids.value, reason } };
}

function parseSourceOpenArgs(raw: unknown): Parsed<SourceOpenArgs> {
  if (!isRecord(raw)) return { ok: false, error: "arguments must be an object" };
  if (typeof raw["sourceId"] !== "string" || raw["sourceId"].trim() === "") {
    return { ok: false, error: "sourceId is required" };
  }
  if (typeof raw["reason"] !== "string" || raw["reason"].trim() === "") {
    return { ok: false, error: "reason is required" };
  }
  const value: SourceOpenArgs = { sourceId: raw["sourceId"], reason: raw["reason"] };
  for (const field of ["start", "maxCharacters"] as const) {
    const candidate = raw[field];
    if (candidate === undefined) continue;
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
      return { ok: false, error: `${field} must be a finite number` };
    }
    value[field] = candidate;
  }
  return { ok: true, value };
}

function parseQueryArgs(raw: unknown): Parsed<QueryArgs> {
  if (!isRecord(raw) || typeof raw["query"] !== "string") {
    return { ok: false, error: "query must be a string" };
  }
  const value: QueryArgs = { query: raw["query"] };
  if (raw["limit"] !== undefined) {
    if (typeof raw["limit"] !== "number" || !Number.isFinite(raw["limit"])) {
      return { ok: false, error: "limit must be a finite number" };
    }
    value.limit = raw["limit"];
  }
  return { ok: true, value };
}

function parseOpenIdsArgs(raw: unknown): Parsed<OpenIdsArgs> {
  if (!isRecord(raw)) return { ok: false, error: "arguments must be an object" };
  const ids = stringArray(raw["ids"], "ids");
  if (!ids.ok) return ids;
  if (typeof raw["reason"] !== "string" || raw["reason"].trim() === "") {
    return { ok: false, error: "reason is required" };
  }
  const value: OpenIdsArgs = { ids: ids.value, reason: raw["reason"] };
  if (raw["maxCharacters"] !== undefined) {
    if (typeof raw["maxCharacters"] !== "number" || !Number.isFinite(raw["maxCharacters"])) {
      return { ok: false, error: "maxCharacters must be a finite number" };
    }
    value.maxCharacters = raw["maxCharacters"];
  }
  return { ok: true, value };
}

function text(body: string): CallToolResult {
  return { content: [{ type: "text", text: body }] };
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function renderRow(row: CardRow): string {
  const marker = row.status === "QUARANTINED" ? `${QUARANTINE_MARKER} ` : "";
  const tags = row.tags.length > 0 ? row.tags.join(", ") : "(none)";
  return (
    `${marker}${row.id} [${row.type}/${row.status}] ${row.title} — ${row.abstract}` +
    ` | provenance: ${row.provenance} | tags: ${tags}`
  );
}

function renderCard(card: MemoryCard, artifact: string | null): string {
  const parts = [
    `=== ${card.id} [${card.type}/${card.status}] ${card.title} ===`,
    `abstract: ${card.abstract}`,
    `provenance: ${card.provenance}`,
    `tags: ${card.tags.length > 0 ? card.tags.join(", ") : "(none)"}`,
    `dependsOn: ${card.dependsOn.length > 0 ? card.dependsOn.join(", ") : "(none)"}`,
    `sourceArtifact: ${card.sourceArtifact ?? "(none)"}`,
    "",
    card.content,
  ];
  if (artifact !== null && card.sourceArtifact !== null) {
    parts.push("", `--- linked artifact (${card.sourceArtifact}) ---`, artifact);
  }
  return parts.join("\n");
}

interface Authorized {
  scope: TaskScope;
  backend: MemoryBackend;
}

export class MemoryService {
  private readonly host: string;
  private readonly configuredPort: number;
  private readonly projects = new Map<string, MemoryBackend>();
  private readonly tokens = new Map<string, TaskScope>();
  private readonly sockets = new Set<Socket>();
  private http: HttpServer | null = null;
  private boundPort: number | null = null;

  constructor(opts: { host?: string; port: number }) {
    this.host = opts.host ?? "127.0.0.1";
    this.configuredPort = opts.port;
  }

  get url(): string {
    return `http://${this.host}:${this.boundPort ?? this.configuredPort}${MCP_PATH}`;
  }

  registerProject(slug: string, backend: MemoryBackend): void {
    this.projects.set(slug, backend);
  }

  unregisterProject(slug: string): void {
    this.projects.delete(slug);
    for (const [token, scope] of this.tokens) {
      if (scope.slug === slug) this.tokens.delete(token);
    }
  }

  /** Random 128-bit task token, mapped to its scope until the task ends. */
  mintToken(scope: TaskScope): string {
    const token = randomBytes(16).toString("hex");
    this.tokens.set(token, scope);
    return token;
  }

  revokeToken(token: string): void {
    this.tokens.delete(token);
  }

  async start(): Promise<void> {
    if (this.http) return;
    const server = createServer((req, res) => {
      this.handle(req, res);
    });
    server.on("connection", (socket: Socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    this.http = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err);
      server.once("error", onError);
      server.listen(this.configuredPort, this.host, () => {
        server.off("error", onError);
        const addr = server.address();
        this.boundPort = typeof addr === "object" && addr !== null ? addr.port : this.configuredPort;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.http;
    if (!server) return;
    this.http = null;
    this.boundPort = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  // ---- HTTP layer -------------------------------------------------------

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    if (path !== MCP_PATH) {
      this.sendError(res, 404, -32004, `not found: ${path}`);
      return;
    }
    const auth = this.authorize(req);
    if (!auth) {
      res.setHeader("WWW-Authenticate", 'Bearer realm="inventio-memory"');
      this.sendError(res, 401, -32001, "unauthorized: a live Bearer task token is required");
      return;
    }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      this.sendError(res, 405, -32000, "method not allowed: the memory service is stateless (POST only)");
      return;
    }
    void this.handlePost(req, res, auth);
  }

  private authorize(req: IncomingMessage): Authorized | null {
    const header = req.headers["authorization"];
    if (typeof header !== "string") return null;
    const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
    if (!match?.[1]) return null;
    const scope = this.tokens.get(match[1]);
    if (!scope) return null;
    const backend = this.projects.get(scope.slug);
    if (!backend) return null;
    return { scope, backend };
  }

  private async handlePost(req: IncomingMessage, res: ServerResponse, auth: Authorized): Promise<void> {
    let body: unknown;
    try {
      const raw = await readBody(req);
      body = raw.length === 0 ? undefined : (JSON.parse(raw) as unknown);
    } catch (err) {
      this.sendError(res, 400, -32700, `parse error: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const server = this.buildServer(auth);
    // `sessionIdGenerator: undefined` is how the SDK selects stateless mode; the option is
    // declared optional-without-undefined, so the cast is needed under exactOptionalPropertyTypes.
    const transportOptions = {
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    } as unknown as StreamableHTTPServerTransportOptions;
    const transport = new StreamableHTTPServerTransport(transportOptions);
    res.on("close", () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    try {
      // The SDK's Transport interface declares optional members without `| undefined`,
      // which exactOptionalPropertyTypes rejects; the shapes are otherwise identical.
      await server.connect(transport as unknown as Parameters<Server["connect"]>[0]);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        this.sendError(res, 500, -32603, `internal error: ${err instanceof Error ? err.message : String(err)}`);
      } else {
        res.end();
      }
    }
  }

  private sendError(res: ServerResponse, status: number, code: number, message: string): void {
    const payload = JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(payload);
  }

  // ---- MCP layer --------------------------------------------------------

  private buildServer(auth: Authorized): Server {
    const server = new Server(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: auth.backend.supportsRecurrentTools?.() ? this.researchTools(auth) : this.trajectoryAllowed(auth)
        ? MODEL_TOOL_DEFINITIONS
        : MODEL_TOOL_DEFINITIONS.filter((tool) => !TRAJECTORY_TOOL_NAMES.has(tool.name)),
    }));

    server.setRequestHandler(CallToolRequestSchema, (request) => {
      const { name, arguments: args } = request.params;
      if (auth.backend.supportsRecurrentTools?.()) {
        if (!this.researchTools(auth).some(tool => tool.name === name)) return toolError("Tool unavailable to this assignment");
        if (name.startsWith("research_") || name === "audit_assess") return this.doResearch(auth, name, args);
      }
      if (name === "knowledge_search") return this.doKnowledgeSearch(auth, args);
      if (name === "knowledge_open") return this.doKnowledgeOpen(auth, args);
      if (name === "writeup_search") return this.doWriteupSearch(auth, args);
      if (name === "writeup_open") return this.doWriteupOpen(auth, args);
      if (name === "mark_milestone") return this.doMarkMilestone(auth, args);
      if (name === "flag_fact") return this.doFlagFact(auth, args);
      if (name === "memory_search") return this.doSearch(auth, args);
      if (name === "memory_expand") return this.doExpand(auth, args);
      if (name === "source_list") return this.doSourceList(auth, args);
      if (name === "source_open") return this.doSourceOpen(auth, args);
      return toolError(`Unknown tool: ${name}`);
    });

    return server;
  }

  private researchTools(auth: Authorized) {
    return RESEARCH_TOOL_DEFINITIONS.filter(tool =>
      (tool.name !== "research_checkpoint" || auth.scope.role === "solver" || auth.scope.role === "explorer") &&
      (tool.name !== "audit_assess" || auth.scope.role === "auditor"));
  }

  private doResearch(auth: Authorized, name: string, args: unknown): CallToolResult {
    if (!isRecord(args)) return toolError("Arguments must be an object");
    try {
      let value: unknown;
      const finite = (key: string, fallback: number): number => {
        const n = args[key];
        if (n === undefined) return fallback;
        if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n) || n < 0) throw new Error(`${key} must be a nonnegative integer`);
        return n;
      };
      if (name === "research_search") {
        if (typeof args.query !== "string") throw new Error("query is required");
        value = auth.backend.searchResearch?.(auth.scope, args.query, finite("limit", 20));
      } else if (name === "research_open") {
        if (typeof args.id !== "string") throw new Error("id is required");
        value = auth.backend.openResearch?.(auth.scope, args.id, finite("start", 0), finite("maxCharacters", 20_000));
      } else if (name === "research_checkpoint") {
        if (args.results !== undefined && !Array.isArray(args.results)) throw new Error("results must be an array");
        value = auth.backend.checkpointResearch?.(auth.scope, (args.results ?? []) as unknown[]);
      } else {
        auth.backend.assessResearch?.(auth.scope, args.assessment);
        value = { recorded: true };
      }
      auth.backend.recordRecall({ taskId: auth.scope.taskId, role: auth.scope.role, op: name as RecallRecord["op"], args: JSON.stringify(args), returnedIds: [], refusedIds: [] });
      return text(JSON.stringify(value ?? null));
    } catch (error) { return toolError(error instanceof Error ? error.message : String(error)); }
  }

  private trajectoryAllowed(auth: Authorized): boolean {
    return auth.backend.supportsTrajectoryTools?.() === true;
  }

  private doKnowledgeSearch(auth: Authorized, rawArgs: unknown): CallToolResult {
    if (!this.trajectoryAllowed(auth) || !auth.backend.searchKnowledge) {
      return toolError("knowledge_search is unavailable for this project");
    }
    const parsed = parseQueryArgs(rawArgs);
    if (!parsed.ok) return toolError(`Invalid arguments for knowledge_search: ${parsed.error}`);
    const rows = auth.backend.searchKnowledge(parsed.value.query, parsed.value.limit);
    auth.backend.recordRecall({
      taskId: auth.scope.taskId,
      role: auth.scope.role,
      op: "knowledge_search",
      args: JSON.stringify(rawArgs ?? {}),
      returnedIds: rows.map((row) => row.id),
      refusedIds: [],
    });
    if (rows.length === 0) return text("No active facts or claims match.");
    return text(rows.map((row) =>
      `${row.id} [${row.kind.toUpperCase()}/${row.status}] ${row.title} — ${row.statement}`
    ).join("\n"));
  }

  private doKnowledgeOpen(auth: Authorized, rawArgs: unknown): CallToolResult {
    if (!this.trajectoryAllowed(auth) || !auth.backend.openKnowledge) {
      return toolError("knowledge_open is unavailable for this project");
    }
    const parsed = parseOpenIdsArgs(rawArgs);
    if (!parsed.ok) return toolError(`Invalid arguments for knowledge_open: ${parsed.error}`);
    const docs = auth.backend.openKnowledge(parsed.value.ids);
    const returned = new Set(docs.map((doc) => doc.id));
    auth.backend.recordRecall({
      taskId: auth.scope.taskId,
      role: auth.scope.role,
      op: "knowledge_open",
      args: JSON.stringify(rawArgs ?? {}),
      returnedIds: [...returned],
      refusedIds: parsed.value.ids.filter((id) => !returned.has(id)),
    });
    if (docs.length === 0) return text("No requested active fact or claim is available.");
    return text(docs.map((doc) =>
      `=== ${doc.id} [${doc.kind.toUpperCase()}/${doc.status}] ===\n\n${doc.markdown}`
    ).join("\n\n"));
  }

  private doWriteupSearch(auth: Authorized, rawArgs: unknown): CallToolResult {
    if (!this.trajectoryAllowed(auth) || !auth.backend.searchWriteups) {
      return toolError("writeup_search is unavailable for this project");
    }
    const parsed = parseQueryArgs(rawArgs);
    if (!parsed.ok) return toolError(`Invalid arguments for writeup_search: ${parsed.error}`);
    const rows = auth.backend.searchWriteups(parsed.value.query, parsed.value.limit);
    auth.backend.recordRecall({
      taskId: auth.scope.taskId,
      role: auth.scope.role,
      op: "writeup_search",
      args: JSON.stringify(rawArgs ?? {}),
      returnedIds: rows.map((row) => row.id),
      refusedIds: [],
    });
    if (rows.length === 0) return text("No earlier write-up matches.");
    return text(rows.map((row) => `${row.id} [${row.role}/${row.status}] — ${row.summary}`).join("\n"));
  }

  private doWriteupOpen(auth: Authorized, rawArgs: unknown): CallToolResult {
    if (!this.trajectoryAllowed(auth) || !auth.backend.openWriteups) {
      return toolError("writeup_open is unavailable for this project");
    }
    const parsed = parseOpenIdsArgs(rawArgs);
    if (!parsed.ok) return toolError(`Invalid arguments for writeup_open: ${parsed.error}`);
    const docs = auth.backend.openWriteups(parsed.value.ids, parsed.value.maxCharacters);
    const returned = new Set(docs.map((doc) => doc.id));
    auth.backend.recordRecall({
      taskId: auth.scope.taskId,
      role: auth.scope.role,
      op: "writeup_open",
      args: JSON.stringify(rawArgs ?? {}),
      returnedIds: [...returned],
      refusedIds: parsed.value.ids.filter((id) => !returned.has(id)),
    });
    if (docs.length === 0) return text("No requested write-up is available.");
    return text(docs.map((doc) => `=== ${doc.id} [${doc.role}] ===\n\n${doc.markdown}`).join("\n\n"));
  }

  private doMarkMilestone(auth: Authorized, rawArgs: unknown): CallToolResult {
    if (!this.trajectoryAllowed(auth) || !auth.backend.recordMilestone) {
      return toolError("mark_milestone is unavailable for this project");
    }
    if (auth.scope.role !== "solver" && auth.scope.role !== "explorer") {
      return toolError("only Solver and Explorer trajectories may record milestones");
    }
    if (
      !isRecord(rawArgs) ||
      typeof rawArgs["title"] !== "string" ||
      rawArgs["title"].trim() === "" ||
      typeof rawArgs["markdown"] !== "string" ||
      rawArgs["markdown"].trim() === ""
    ) {
      return toolError("title and markdown are required");
    }
    try {
      const result = auth.backend.recordMilestone(
        auth.scope.taskId,
        rawArgs["title"],
        rawArgs["markdown"],
      );
      auth.backend.recordRecall({
        taskId: auth.scope.taskId,
        role: auth.scope.role,
        op: "mark_milestone",
        args: JSON.stringify(rawArgs),
        returnedIds: [result.milestoneId],
        refusedIds: [],
      });
      return text(`Recorded ${result.milestoneId}.`);
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
  }

  private doFlagFact(auth: Authorized, rawArgs: unknown): CallToolResult {
    if (!this.trajectoryAllowed(auth) || !auth.backend.flagFact) {
      return toolError("flag_fact is unavailable for this project");
    }
    if (auth.scope.role !== "solver" && auth.scope.role !== "explorer") {
      return toolError("only Solver and Explorer trajectories may flag a fact");
    }
    if (
      !isRecord(rawArgs) ||
      typeof rawArgs["factId"] !== "string" ||
      !/^F\d{3,}$/.test(rawArgs["factId"]) ||
      typeof rawArgs["reason"] !== "string" ||
      rawArgs["reason"].trim().length < 20 ||
      rawArgs["reason"].length > 2_000
    ) {
      return toolError("factId and a concrete 20–2000 character mathematical reason are required");
    }
    try {
      const result = auth.backend.flagFact(auth.scope.taskId, rawArgs["factId"], rawArgs["reason"]);
      auth.backend.recordRecall({
        taskId: auth.scope.taskId,
        role: auth.scope.role,
        op: "flag_fact",
        args: JSON.stringify(rawArgs),
        returnedIds: [result.correctionClaimId],
        refusedIds: [],
      });
      return text(`Recorded correction claim ${result.correctionClaimId}; it will be independently checked.`);
    } catch (error) {
      return toolError(error instanceof Error ? error.message : String(error));
    }
  }

  private doSearch(auth: Authorized, rawArgs: unknown): CallToolResult {
    const parsed = parseSearchArgs(rawArgs);
    if (!parsed.ok) return toolError(`Invalid arguments for memory_search: ${parsed.error}`);
    const args = parsed.value;

    // Reviewers only ever see VERIFIED cards (PROTOCOL.md §7).
    let statuses = args.statuses;
    if (auth.scope.role === "reviewer") {
      statuses = statuses ? statuses.filter((s) => s === "VERIFIED") : ["VERIFIED"];
    }

    const query: SearchQuery = { query: args.query };
    if (args.types !== undefined) query.types = args.types;
    if (statuses !== undefined) query.statuses = statuses;
    if (args.tags !== undefined) query.tags = args.tags;
    if (args.limit !== undefined) query.limit = args.limit;

    const rows = auth.backend.searchCards(query);
    auth.backend.recordRecall({
      taskId: auth.scope.taskId,
      role: auth.scope.role,
      op: "search",
      args: JSON.stringify(rawArgs ?? {}),
      returnedIds: rows.map((r) => r.id),
      refusedIds: [],
    });

    if (rows.length === 0) return text("No cards match.");
    return text(rows.map(renderRow).join("\n"));
  }

  private doExpand(auth: Authorized, rawArgs: unknown): CallToolResult {
    const parsed = parseExpandArgs(rawArgs);
    if (!parsed.ok) return toolError(`Invalid arguments for memory_expand: ${parsed.error}`);
    const args = parsed.value;

    const byId = new Map<string, MemoryCard>();
    for (const card of auth.backend.getCards(args.cardIds)) byId.set(card.id, card);

    const blocks: string[] = [];
    const returnedIds: string[] = [];
    const refusedIds: string[] = [];

    for (const id of args.cardIds) {
      const card = byId.get(id);
      if (!card) {
        blocks.push(`UNKNOWN ${id}`);
        continue;
      }
      if (card.status === "QUARANTINED") {
        refusedIds.push(id);
        blocks.push(`REFUSED ${id}: card is QUARANTINED — warning only, never presented as fact`);
        continue;
      }
      if (auth.scope.role === "reviewer" && card.status !== "VERIFIED") {
        refusedIds.push(id);
        blocks.push(`REFUSED ${id}: reviewers may expand only VERIFIED cards (this card is ${card.status})`);
        continue;
      }
      returnedIds.push(id);
      blocks.push(renderCard(card, auth.backend.readLinkedArtifact(card)));
    }

    auth.backend.recordRecall({
      taskId: auth.scope.taskId,
      role: auth.scope.role,
      op: "expand",
      args: JSON.stringify(rawArgs ?? {}),
      returnedIds,
      refusedIds,
    });

    if (blocks.length === 0) return text("No cards requested.");
    return text(blocks.join("\n\n"));
  }

  private doSourceList(auth: Authorized, rawArgs: unknown): CallToolResult {
    if (auth.scope.role !== "research_manager" && !this.trajectoryAllowed(auth)) {
      return toolError("source_list is unavailable to this assignment");
    }
    if (!isRecord(rawArgs) || typeof rawArgs["query"] !== "string") {
      return toolError("Invalid arguments for source_list: query must be a string");
    }
    const blind = auth.backend.supportsRecurrentTools?.() && (auth.scope.role === "auditor" || auth.scope.role === "verifier");
    const query = rawArgs["query"].toLowerCase();
    const rows = blind ? auth.backend.listIntakeSources("").filter(row => `${row.id} ${row.title} ${row.kind}`.toLowerCase().includes(query)) : auth.backend.listIntakeSources(rawArgs["query"]);
    auth.backend.recordRecall({
      taskId: auth.scope.taskId,
      role: auth.scope.role,
      op: "source_list",
      args: JSON.stringify(rawArgs),
      returnedIds: rows.map((row) => row.id),
      refusedIds: [],
    });
    if (rows.length === 0) return text("No intake sources match.");
    if (auth.backend.supportsRecurrentTools?.() && (auth.scope.role === "auditor" || auth.scope.role === "verifier")) {
      return text(rows.map(row => `${row.id} [${row.kind}] ${row.title}`).join("\n"));
    }
    return text(rows.map((row) =>
      `${row.id} [${row.kind}] ${row.title} — ${row.abstract}` +
      (row.excerptMarkdown.trim() ? `\n${row.excerptMarkdown.trim()}` : "")
    ).join("\n\n"));
  }

  private doSourceOpen(auth: Authorized, rawArgs: unknown): CallToolResult {
    if (auth.scope.role !== "research_manager" && !this.trajectoryAllowed(auth)) {
      return toolError("source_open is unavailable to this assignment");
    }
    const parsed = parseSourceOpenArgs(rawArgs);
    if (!parsed.ok) return toolError(`Invalid arguments for source_open: ${parsed.error}`);
    const args = parsed.value;
    const opened = auth.backend.openIntakeSource(args.sourceId, args.start, args.maxCharacters);
    auth.backend.recordRecall({
      taskId: auth.scope.taskId,
      role: auth.scope.role,
      op: "source_open",
      args: JSON.stringify(rawArgs),
      returnedIds: opened ? [args.sourceId] : [],
      refusedIds: opened ? [] : [args.sourceId],
    });
    if (!opened) {
      return toolError(`Cannot open ${args.sourceId}: it is missing or its file type has no text extractor.`);
    }
    const range = `${opened.start}-${opened.end} of ${opened.totalCharacters} characters`;
    return text(
      `=== ${opened.source.id} ${opened.source.title} (${range}) ===\n\n${opened.text}` +
      (opened.truncated ? `\n\n[More remains; call source_open again with start=${opened.end}.]` : ""),
    );
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}
