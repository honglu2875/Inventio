import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { z } from "zod";
import {
  INTAKE_ABSTRACT_MAX_CHARS,
  IntakeMemory,
  ReasoningEffort,
  SLUG_RE,
  type Event,
} from "@inventio/schema";
import type { ProjectEngine } from "../engine/engine.js";
import { EngineManager, ManagerError } from "./manager.js";
import {
  buildProjectExportSnapshot,
  renderStandaloneProjectHtml,
  taskMemoFromOutput,
} from "./projectExport.js";
import { openSse, resumeCursor, tailJsonl } from "./sse.js";
import { MAX_UPLOAD_BYTES } from "./uploads.js";

export { taskMemoFromOutput } from "./projectExport.js";

/**
 * The control surface (DESIGN §12). Same-origin, loopback-bound, no auth:
 * binding is main.ts's job. Every route is derived from an engine — the HTTP
 * layer holds no state, so a reconnect after a conductor restart is just
 * another snapshot + `?since=`.
 */

export const SERVER_VERSION = "0.1.0";

const BODY_LIMIT = 1_000_000;
/** Raw file uploads get their own limit; a hair over the per-file cap. */
const UPLOAD_BODY_LIMIT = MAX_UPLOAD_BYTES + 4096;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** packages/conductor/src/server → packages/ui/dist */
export const DEFAULT_UI_DIR = path.resolve(HERE, "../../../ui/dist");

export interface BuildAppOpts {
  /** static UI build to serve at `/`; null disables. Default packages/ui/dist. */
  uiDir?: string | null;
  logger?: boolean;
  /** SSE keepalive comment interval */
  heartbeatMs?: number;
  /** task archive tail poll interval */
  tailPollMs?: number;
}

// ---------------------------------------------------------------- body shapes

const CreateProjectBody = z.object({
  title: z.string().min(1).max(300),
  slug: z.string().optional(),
  statement: z.string().min(1).max(100_000),
  contextMarkdown: z.string().max(300_000).optional(),
  config: z.unknown().optional(),
  /** False parks the project in CREATED while its source files are uploaded. */
  start: z.boolean().optional(),
});
const CloneIntakeBody = z.object({
  title: z.string().min(1).max(300),
});
const RawIntakeBody = z.object({
  statement: z.string().min(1).max(100_000).refine((value) => value.trim() !== "", "cannot be blank"),
  contextMarkdown: z.string().max(300_000),
});
const ConfirmProblemBody = z.object({
  problemMarkdown: z.string().min(1).max(200_000),
  contextDigestMarkdown: z.string().max(6_000).optional(),
  rawMemories: z.array(IntakeMemory).max(8).optional(),
  managerAbstract: z.string().max(INTAKE_ABSTRACT_MAX_CHARS).optional(),
  managerNoteMarkdown: z.string().min(1).max(16_000).optional(),
});
const AutonomyBody = z.object({ mode: z.enum(["auto", "gated"]) });
const WebSearchBody = z.object({ enabled: z.boolean() });
const ModelId = z.string().trim().min(1).max(200).regex(/^\S+$/, "must not contain whitespace");
const SettingsModelChoice = z.object({ model: ModelId.nullable(), effort: ReasoningEffort });
const ModelSettingsBody = z.object({
  researchManager: SettingsModelChoice,
  summaryReader: SettingsModelChoice.optional(),
  solver: SettingsModelChoice,
  explorer: SettingsModelChoice,
  verifier: SettingsModelChoice.optional(),
  reviewer: SettingsModelChoice,
  synthesizer: SettingsModelChoice,
});
const ProjectSettingsBody = z.object({
  models: ModelSettingsBody,
  autonomy: z.enum(["auto", "gated"]),
  allowWebSearch: z.boolean(),
  totalTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  workerTokenLimit: z.number().int().min(60_000).max(Number.MAX_SAFE_INTEGER).optional(),
  maxWaves: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  trajectory: z
    .object({
      solversPerWave: z.number().int().min(0).max(8),
      explorersPerWave: z.number().int().min(0).max(8),
      verifiersPerClaim: z.number().int().min(1).max(8),
      passesRequired: z.number().int().min(1).max(8),
    })
    .superRefine((value, ctx) => {
      if (value.solversPerWave + value.explorersPerWave < 1) {
        ctx.addIssue({ code: "custom", message: "at least one Solver or Explorer is required" });
      }
      if (value.solversPerWave + value.explorersPerWave > 8) {
        ctx.addIssue({ code: "custom", message: "at most eight research trajectories may start per round" });
      }
      if (value.passesRequired > value.verifiersPerClaim) {
        ctx.addIssue({ code: "custom", message: "passesRequired cannot exceed verifiersPerClaim" });
      }
    })
    .optional(),
});
const DirectiveBody = z.object({
  text: z.string().min(1).max(10_000),
  urgent: z.boolean().optional(),
});
const AnswerBody = z.object({ answer: z.string().min(1).max(50_000) });
const GateBody = z.object({
  resolution: z.enum(["approve", "edit", "reject"]),
  action: z.unknown().optional(),
  note: z.string().max(10_000).optional(),
});
const ExtendBody = z.object({ addTokens: z.number().int().positive() });
const ContinueBody = z.object({
  note: z.string().min(1).max(10_000),
  addTokens: z.number().int().min(0).max(100_000_000).default(0),
  addWaves: z.number().int().min(0).max(100).default(0),
  humanRevisionMarkdown: z.string().min(1).max(16_000).optional(),
});
const ClaimStatusBody = z.object({
  to: z.enum(["VERIFIED", "FAILED", "REFUTED"]),
  note: z.string().min(1).max(10_000),
});
const IssueBody = z.object({
  candidateId: z.string().min(1).max(64),
  severity: z.enum(["CRITICAL", "MAJOR", "MINOR"]),
  location: z.string().max(500).default(""),
  text: z.string().min(1).max(10_000),
});
const QuarantineBody = z.object({ note: z.string().min(1).max(10_000) });

// -------------------------------------------------------------------- helpers

function errorCode(status: number): string {
  return status === 400
    ? "invalid_request"
    : status === 404
      ? "not_found"
      : status === 409
        ? "conflict"
        : "error";
}

/** Engine steering errors are `Error("unknown …")` (404) or bad state (409). */
function engineErrorStatus(message: string): number {
  return /^unknown /i.test(message) ? 404 : 409;
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    throw new ManagerError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "),
      400,
    );
  }
  return parsed.data;
}

/** Resolve `rel` inside `baseDir`, refusing anything that escapes it. */
function confine(baseDir: string, rel: string): string {
  if (rel.includes("\0")) throw new ManagerError("invalid path", 400);
  const base = path.resolve(baseDir);
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new ManagerError(`path escapes ${path.basename(base)}`, 400);
  }
  return target;
}

function readJsonIfPresent(baseDir: string, file: string): unknown {
  const target = confine(baseDir, file);
  if (!existsSync(target)) return null;
  try {
    return JSON.parse(readFileSync(target, "utf8")) as unknown;
  } catch {
    return null;
  }
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const codexVersionCache = new Map<string, { version: string | null; ok: boolean }>();

function probeCodex(bin: string): { bin: string; version: string | null; ok: boolean } {
  const cached = codexVersionCache.get(bin);
  if (cached) return { bin, ...cached };
  let probe: { version: string | null; ok: boolean };
  try {
    const res = spawnSync(bin, ["--version"], { timeout: 5000, encoding: "utf8" });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
    probe =
      res.error || res.status !== 0
        ? { version: null, ok: false }
        : { version: out.split("\n")[0]?.trim() || null, ok: true };
  } catch {
    probe = { version: null, ok: false };
  }
  codexVersionCache.set(bin, probe);
  return { bin, ...probe };
}

// ----------------------------------------------------------------------- app

export function buildApp(manager: EngineManager, opts: BuildAppOpts = {}): FastifyInstance {
  const app = Fastify({
    bodyLimit: BODY_LIMIT,
    logger: opts.logger ?? false,
    // SSE clients hold their sockets open forever: close() must not wait.
    forceCloseConnections: true,
  });
  /**
   * Source uploads post the file as a raw body (DESIGN §12): no multipart
   * parser is installed and none is worth a dependency, so the transport is
   * `content-type: application/octet-stream` plus an `x-filename` header.
   */
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer", bodyLimit: UPLOAD_BODY_LIMIT },
    (_request, body, done) => {
      done(null, body);
    },
  );

  const uiDirOpt = opts.uiDir === undefined ? DEFAULT_UI_DIR : opts.uiDir;
  const uiDir = uiDirOpt !== null && existsSync(uiDirOpt) ? path.resolve(uiDirOpt) : null;
  const sseOpts = opts.heartbeatMs === undefined ? {} : { heartbeatMs: opts.heartbeatMs };

  /** Run a handler body, mapping ManagerError / engine errors onto 4xx. */
  const run = async <T>(reply: FastifyReply, fn: () => T | Promise<T>): Promise<unknown> => {
    try {
      return await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof ManagerError ? err.status : engineErrorStatus(message);
      return reply.code(status).send({ error: errorCode(status), detail: message });
    }
  };

  const checkedSlug = (slug: string): string => {
    if (!SLUG_RE.test(slug)) throw new ManagerError(`invalid slug ${slug}`, 400);
    return slug;
  };

  const engineOf = (slug: string): ProjectEngine => manager.require(checkedSlug(slug));

  const checkedId = (id: string, what: string): string => {
    if (!ID_RE.test(id)) throw new ManagerError(`invalid ${what} id`, 400);
    return id;
  };

  // ------------------------------------------------------------- diagnostics

  app.get("/api/health", async () => ({
    ok: true,
    version: SERVER_VERSION,
    root: manager.root,
    codexBin: manager.codexBin,
  }));

  app.get("/api/runtime", async () => ({
    codex: probeCodex(manager.codexBin),
    tex: manager.publicationCompiler.info(),
    pool: { active: manager.pool.active, queued: manager.pool.queued },
    projects: manager.list().length,
  }));

  // ---------------------------------------------------------------- projects

  app.get("/api/projects", async () => manager.list());

  app.post("/api/projects", async (request, reply) =>
    run(reply, () => {
      const body = parseBody(CreateProjectBody, request.body);
      const engine = manager.createProject({
        title: body.title,
        statement: body.statement,
        ...(body.contextMarkdown !== undefined ? { contextMarkdown: body.contextMarkdown } : {}),
        ...(body.slug !== undefined ? { slug: body.slug } : {}),
        ...(body.config !== undefined ? { config: body.config } : {}),
        ...(body.start !== undefined ? { start: body.start } : {}),
      });
      reply.code(201);
      return { slug: engine.slug };
    }),
  );

  app.post<{ Params: { slug: string } }>(
    "/api/projects/:slug/clone-intake",
    async (request, reply) =>
      run(reply, () => {
        const body = parseBody(CloneIntakeBody, request.body);
        const engine = manager.cloneIntake(checkedSlug(request.params.slug), { title: body.title });
        reply.code(201);
        return { slug: engine.slug, phase: engine.state.phase };
      }),
  );

  app.get<{ Params: { slug: string } }>("/api/projects/:slug", async (request, reply) =>
    run(reply, () => {
      const engine = engineOf(request.params.slug);
      return { state: engine.state, seq: engine.state.seq };
    }),
  );

  app.get<{ Params: { slug: string } }>(
    "/api/projects/:slug/export-html",
    async (request, reply) =>
      run(reply, () => {
        if (uiDir === null) {
          throw new ManagerError(
            "HTML export requires the built Inventio UI; run npm run build and retry",
            503,
          );
        }
        const engine = engineOf(request.params.slug);
        const snapshot = buildProjectExportSnapshot(engine);
        const html = renderStandaloneProjectHtml(uiDir, snapshot);
        const day = snapshot.exportedAt.slice(0, 10);
        void reply
          .type("text/html; charset=utf-8")
          .header("cache-control", "no-store")
          .header(
            "content-disposition",
            `attachment; filename*=UTF-8''${encodeURIComponent(`inventio-${engine.slug}-${day}.html`)}`,
          );
        return html;
      }),
  );

  // --------------------------------------------------------- source uploads

  /**
   * `POST /api/projects/:slug/sources`
   *   headers: `content-type: application/octet-stream`, `x-filename: <name>`
   *   body:    the raw file bytes (≤ 10 MB; ≤ 100 MB per project)
   *   → `{ name, size, uploadedAt, mount }`
   *
   * The filename may be percent-encoded (headers are latin-1). On success the
   * project gains a source mount named `uploads`, so the Research Manager can grant the
   * files with `grants.sourceMounts: ["uploads"]`.
   */
  app.post<{ Params: { slug: string } }>(
    "/api/projects/:slug/sources",
    { bodyLimit: UPLOAD_BODY_LIMIT },
    async (request, reply) =>
      run(reply, () => {
        const slug = checkedSlug(request.params.slug);
        const header = request.headers["x-filename"];
        const filename = Array.isArray(header) ? header[0] : header;
        if (filename === undefined || filename === "") {
          throw new ManagerError("x-filename header is required", 400);
        }
        const body = request.body;
        if (!Buffer.isBuffer(body)) {
          throw new ManagerError(
            "upload body must be sent as content-type: application/octet-stream",
            400,
          );
        }
        const stored = manager.uploadSource(slug, filename, body);
        reply.code(201);
        return stored;
      }),
  );

  app.get<{ Params: { slug: string } }>("/api/projects/:slug/sources", async (request, reply) =>
    run(reply, () => manager.listSources(checkedSlug(request.params.slug))),
  );

  app.get<{ Params: { slug: string; name: string } }>(
    "/api/projects/:slug/sources/:name",
    async (request, reply) =>
      run(reply, () => {
        const source = manager.readSource(checkedSlug(request.params.slug), request.params.name);
        const extension = path.extname(source.name).toLowerCase();
        const contentType =
          extension === ".pdf"
            ? "application/pdf"
            : [".md", ".txt", ".tex", ".bib", ".csv", ".json"].includes(extension)
              ? "text/plain; charset=utf-8"
              : "application/octet-stream";
        void reply.type(contentType).header(
          "content-disposition",
          `inline; filename*=UTF-8''${encodeURIComponent(source.name)}`,
        );
        return source.data;
      }),
  );

  app.delete<{ Params: { slug: string; name: string } }>(
    "/api/projects/:slug/sources/:name",
    async (request, reply) =>
      run(reply, () => {
        manager.deleteSource(checkedSlug(request.params.slug), request.params.name);
        return { ok: true };
      }),
  );

  // --------------------------------------------------------- project SSE feed

  app.get<{ Params: { slug: string }; Querystring: { since?: string } }>(
    "/api/projects/:slug/events",
    (request, reply) => {
      let engine: ProjectEngine;
      try {
        engine = engineOf(request.params.slug);
      } catch (err) {
        const status = err instanceof ManagerError ? err.status : 500;
        void reply
          .code(status)
          .send({ error: errorCode(status), detail: err instanceof Error ? err.message : "error" });
        return;
      }

      const channel = openSse(request, reply, sseOpts);
      let lastSent = resumeCursor(request.query.since, request.headers["last-event-id"]);

      const onEvent = (event: Event): void => {
        if (event.seq <= lastSent) return;
        lastSent = event.seq;
        channel.send(JSON.stringify(event), event.seq);
      };
      // Attach first, then replay synchronously: no append can interleave.
      engine.on("event", onEvent);
      channel.onClose(() => engine.off("event", onEvent));
      for (const event of engine.events) onEvent(event);
    },
  );

  // ------------------------------------------------------------ read surfaces

  app.get<{ Params: { slug: string; id: string } }>(
    "/api/projects/:slug/artifacts/:id",
    async (request, reply) =>
      run(reply, () => {
        const engine = engineOf(request.params.slug);
        const id = checkedId(request.params.id, "artifact");
        const recorded = engine.state.artifacts[id];
        const verification = engine.state.verifications[id];
        const fact = engine.state.facts[id];
        const meta =
          recorded ??
          (verification?.artifactPath
            ? {
                id,
                kind: "verification" as const,
                conclusion: verification.verdict,
                path: verification.artifactPath,
              }
            : fact
              ? { id, kind: "fact" as const, conclusion: fact.status, path: fact.path }
              : null);
        if (!meta) throw new ManagerError(`unknown artifact ${id}`, 404);
        const file = confine(engine.paths.dir, meta.path);
        if (!existsSync(file)) throw new ManagerError(`artifact file missing: ${meta.path}`, 404);
        return {
          id: meta.id,
          kind: meta.kind,
          conclusion: meta.conclusion,
          path: meta.path,
          markdown: readFileSync(file, "utf8"),
        };
      }),
  );

  app.get<{ Params: { slug: string; id: string } }>(
    "/api/projects/:slug/publications/:id/tex",
    async (request, reply) =>
      run(reply, () => {
        const engine = engineOf(request.params.slug);
        const id = checkedId(request.params.id, "publication");
        const publication = engine.state.publications.find((entry) => entry.id === id);
        if (!publication) throw new ManagerError("unknown publication " + id, 404);
        if (publication.texPath === null) {
          throw new ManagerError("publication " + id + " does not have a saved TeX manuscript", 409);
        }
        const file = confine(engine.paths.dir, publication.texPath);
        if (!existsSync(file) || !statSync(file).isFile()) {
          throw new ManagerError("publication TeX is missing: " + publication.texPath, 404);
        }
        const filename =
          (publication.kind === "preprint" ? "preprint" : "research-report") +
          "-" +
          engine.slug +
          ".tex";
        void reply
          .type("application/x-tex; charset=utf-8")
          .header(
            "content-disposition",
            "attachment; filename*=UTF-8''" + encodeURIComponent(filename),
          );
        return readFileSync(file, "utf8");
      }),
  );

  app.get<{ Params: { slug: string; id: string } }>(
    "/api/projects/:slug/publications/:id/pdf",
    async (request, reply) =>
      run(reply, () => {
        const engine = engineOf(request.params.slug);
        const id = checkedId(request.params.id, "publication");
        const publication = engine.state.publications.find((entry) => entry.id === id);
        if (!publication) throw new ManagerError("unknown publication " + id, 404);
        if (publication.status !== "ready" || publication.pdfPath === null) {
          throw new ManagerError("publication " + id + " does not have a ready PDF", 409);
        }
        const file = confine(engine.paths.dir, publication.pdfPath);
        if (!existsSync(file) || !statSync(file).isFile()) {
          throw new ManagerError("publication PDF is missing: " + publication.pdfPath, 404);
        }
        const filename =
          (publication.kind === "preprint" ? "preprint" : "research-report") +
          "-" +
          engine.slug +
          ".pdf";
        void reply
          .type("application/pdf")
          .header(
            "content-disposition",
            "attachment; filename*=UTF-8''" + encodeURIComponent(filename),
          );
        return readFileSync(file);
      }),
  );

  app.get<{ Params: { slug: string; id: string } }>(
    "/api/projects/:slug/tasks/:id",
    async (request, reply) =>
      run(reply, () => {
        const engine = engineOf(request.params.slug);
        const id = checkedId(request.params.id, "task");
        const detail = engine.taskDetail(id); // throws `unknown task …` → 404
        const taskDir = path.dirname(detail.outputPath);
        const output = readJsonIfPresent(engine.paths.dir, detail.outputPath);
        return {
          task: detail.task,
          packetManifest: detail.task.packetManifest,
          memo: taskMemoFromOutput(output),
          meta: readJsonIfPresent(engine.paths.dir, path.join(taskDir, "meta.json")),
          partialWorkMarkdown: detail.partialWorkMarkdown,
        };
      }),
  );

  app.get<{ Params: { slug: string; id: string; "*": string } }>(
    "/api/projects/:slug/tasks/:id/packet/*",
    async (request, reply) =>
      run(reply, () => {
        const engine = engineOf(request.params.slug);
        const id = checkedId(request.params.id, "task");
        const rel = request.params["*"] ?? "";
        if (rel === "") throw new ManagerError("packet path required", 400);
        // A traversal attempt is a bad request whether or not the task exists.
        if (rel.includes("\0") || rel.startsWith("/") || rel.split(/[\\/]/).includes("..")) {
          throw new ManagerError("packet path escapes the packet", 400);
        }
        const detail = engine.taskDetail(id);
        const file = confine(detail.packetDir, rel);
        if (!existsSync(file) || !statSync(file).isFile()) {
          throw new ManagerError(`no packet file ${rel}`, 404);
        }
        void reply.type("text/plain; charset=utf-8");
        return readFileSync(file, "utf8");
      }),
  );

  app.get<{ Params: { slug: string; id: string } }>(
    "/api/projects/:slug/tasks/:id/stream",
    (request, reply) => {
      let archive: string;
      try {
        const engine = engineOf(request.params.slug);
        archive = engine.taskDetail(checkedId(request.params.id, "task")).archive;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const status = err instanceof ManagerError ? err.status : engineErrorStatus(message);
        void reply.code(status).send({ error: errorCode(status), detail: message });
        return;
      }
      const channel = openSse(request, reply, sseOpts);
      const tail = tailJsonl(archive, (line) => channel.send(line), {
        tailLines: 200,
        ...(opts.tailPollMs === undefined ? {} : { pollMs: opts.tailPollMs }),
      });
      channel.onClose(() => tail.stop());
    },
  );

  // --------------------------------------------------------------- lifecycle

  app.post<{ Params: { slug: string } }>(
    "/api/projects/:slug/raw-intake",
    async (request, reply) =>
      run(reply, () => {
        const engine = engineOf(request.params.slug);
        const body = parseBody(RawIntakeBody, request.body);
        engine.updateRawIntake(body.statement, body.contextMarkdown);
        return { ok: true, phase: engine.state.phase };
      }),
  );

  app.post<{ Params: { slug: string } }>(
    "/api/projects/:slug/confirm-problem",
    async (request, reply) =>
      run(reply, () => {
        const engine = engineOf(request.params.slug);
        const body = parseBody(ConfirmProblemBody, request.body);
        engine.confirmProblem(
          body.problemMarkdown,
          body.contextDigestMarkdown,
          body.rawMemories,
          body.managerAbstract,
          body.managerNoteMarkdown,
        );
        return { ok: true, phase: engine.state.phase };
      }),
  );

  app.post<{ Params: { slug: string } }>(
    "/api/projects/:slug/regenerate-intake",
    async (request, reply) =>
      run(reply, async () => {
        const engine = engineOf(request.params.slug);
        await engine.regenerateIntake();
        return { ok: true, phase: engine.state.phase };
      }),
  );

  app.post<{ Params: { slug: string } }>("/api/projects/:slug/start", async (request, reply) =>
    run(reply, () => {
      const engine = engineOf(request.params.slug);
      engine.start(); // idempotent
      return { ok: true, phase: engine.state.phase };
    }),
  );

  app.post<{ Params: { slug: string } }>("/api/projects/:slug/pause", async (request, reply) =>
    run(reply, () => {
      const engine = engineOf(request.params.slug);
      engine.pause();
      return { ok: true, paused: engine.state.paused };
    }),
  );

  app.post<{ Params: { slug: string } }>("/api/projects/:slug/resume", async (request, reply) =>
    run(reply, () => {
      const engine = engineOf(request.params.slug);
      engine.resume();
      return { ok: true, paused: engine.state.paused };
    }),
  );

  app.post<{ Params: { slug: string } }>("/api/projects/:slug/continue", async (request, reply) =>
    run(reply, () => {
      const engine = engineOf(request.params.slug);
      const body = parseBody(ContinueBody, request.body);
      engine.continueResearch(
        body.note,
        body.addTokens,
        body.addWaves,
        "human",
        body.humanRevisionMarkdown,
      );
      return {
        ok: true,
        phase: engine.state.phase,
        totalTokens: engine.state.budget.totalTokens,
        maxWaves: engine.state.config.limits.maxWaves,
      };
    }),
  );

  app.post<{ Params: { slug: string } }>(
    "/api/projects/:slug/publication",
    async (request, reply) =>
      run(reply, () => {
        const engine = engineOf(request.params.slug);
        const publicationId = engine.requestPublication();
        const publication = engine.state.publications.find(
          (entry) => entry.id === publicationId,
        );
        void reply.code(202);
        return {
          ok: true,
          publicationId,
          status: publication?.status ?? "drafting",
        };
      }),
  );

  app.post<{ Params: { slug: string; id: string } }>(
    "/api/projects/:slug/publications/:id/compile",
    async (request, reply) =>
      run(reply, () => {
        const engine = engineOf(request.params.slug);
        const publicationId = checkedId(request.params.id, "publication");
        engine.requestPublicationCompilation(publicationId);
        const publication = engine.state.publications.find(
          (entry) => entry.id === publicationId,
        );
        void reply.code(202);
        return {
          ok: true,
          publicationId,
          status: publication?.status ?? "compiling",
        };
      }),
  );

  app.post<{ Params: { slug: string } }>("/api/projects/:slug/autonomy", async (request, reply) =>
    run(reply, () => {
      const engine = engineOf(request.params.slug);
      const body = parseBody(AutonomyBody, request.body);
      engine.setAutonomy(body.mode);
      return { ok: true, autonomy: engine.state.config.autonomy };
    }),
  );

  app.get<{ Params: { slug: string } }>("/api/projects/:slug/settings", async (request, reply) =>
    run(reply, () => ({ settings: engineOf(request.params.slug).getProjectSettings() })),
  );

  app.post<{ Params: { slug: string } }>("/api/projects/:slug/settings", async (request, reply) =>
    run(reply, () => {
      const engine = engineOf(request.params.slug);
      const body = parseBody(ProjectSettingsBody, request.body);
      engine.setProjectSettings(body);
      return { ok: true, settings: engine.getProjectSettings() };
    }),
  );

  app.post<{ Params: { slug: string } }>("/api/projects/:slug/web-search", async (request, reply) =>
    run(reply, () => {
      const engine = engineOf(request.params.slug);
      const body = parseBody(WebSearchBody, request.body);
      engine.setWebSearch(body.enabled);
      return { ok: true, enabled: engine.state.config.allowWebSearch };
    }),
  );

  app.post<{ Params: { slug: string } }>("/api/projects/:slug/models", async (request, reply) =>
    run(reply, () => {
      const engine = engineOf(request.params.slug);
      const body = parseBody(ModelSettingsBody, request.body);
      engine.setModelSettings(body);
      const models = engine.state.config.models;
      return {
        ok: true,
        models: {
          researchManager: models.researchManager,
          solver: models.solver,
          explorer: models.explorer,
          reviewer: models.reviewer,
          synthesizer: models.synthesizer,
        },
      };
    }),
  );

  // ----------------------------------------------------------------- steering

  app.post<{ Params: { slug: string } }>("/api/projects/:slug/directives", async (request, reply) =>
    run(reply, () => {
      const engine = engineOf(request.params.slug);
      const body = parseBody(DirectiveBody, request.body);
      return { id: engine.submitDirective(body.text, body.urgent ?? false) };
    }),
  );

  app.post<{ Params: { slug: string; id: string } }>(
    "/api/projects/:slug/questions/:id/answer",
    async (request, reply) =>
      run(reply, () => {
        const engine = engineOf(request.params.slug);
        const body = parseBody(AnswerBody, request.body);
        engine.answerQuestion(checkedId(request.params.id, "question"), body.answer);
        return { ok: true };
      }),
  );

  app.post<{ Params: { slug: string; id: string } }>(
    "/api/projects/:slug/questions/:id/dismiss",
    async (request, reply) =>
      run(reply, () => {
        const engine = engineOf(request.params.slug);
        engine.dismissQuestion(checkedId(request.params.id, "question"));
        return { ok: true };
      }),
  );

  app.post<{ Params: { slug: string; decisionId: string } }>(
    "/api/projects/:slug/gates/:decisionId",
    async (request, reply) =>
      run(reply, () => {
        const engine = engineOf(request.params.slug);
        const body = parseBody(GateBody, request.body);
        engine.resolveGate(
          checkedId(request.params.decisionId, "decision"),
          body.resolution,
          body.action,
          body.note,
        );
        return { ok: true };
      }),
  );

  app.post<{ Params: { slug: string; id: string } }>(
    "/api/projects/:slug/waves/:id/interrupt",
    async (request, reply) =>
      run(reply, () => {
        const engine = engineOf(request.params.slug);
        engine.softInterruptWave(checkedId(request.params.id, "wave"));
        return { ok: true };
      }),
  );

  app.post<{ Params: { slug: string; id: string } }>(
    "/api/projects/:slug/tasks/:id/interrupt",
    async (request, reply) =>
      run(reply, () => {
        const engine = engineOf(request.params.slug);
        engine.hardInterruptTask(checkedId(request.params.id, "task"));
        return { ok: true };
      }),
  );

  app.post<{ Params: { slug: string; id: string } }>(
    "/api/projects/:slug/tasks/:id/extend",
    async (request, reply) =>
      run(reply, () => {
        const engine = engineOf(request.params.slug);
        const body = parseBody(ExtendBody, request.body);
        engine.extendTask(checkedId(request.params.id, "task"), body.addTokens);
        return { ok: true };
      }),
  );

  // ------------------------------------------------------ ledger intervention

  app.post<{ Params: { slug: string; id: string } }>(
    "/api/projects/:slug/claims/:id/status",
    async (request, reply) =>
      run(reply, () => {
        const engine = engineOf(request.params.slug);
        const body = parseBody(ClaimStatusBody, request.body);
        engine.humanClaimStatus(checkedId(request.params.id, "claim"), body.to, body.note);
        return { ok: true };
      }),
  );

  app.post<{ Params: { slug: string } }>("/api/projects/:slug/issues", async (request, reply) =>
    run(reply, () => {
      const engine = engineOf(request.params.slug);
      const body = parseBody(IssueBody, request.body);
      return {
        issueId: engine.humanRaiseIssue(body.candidateId, body.severity, body.location, body.text),
      };
    }),
  );

  app.post<{ Params: { slug: string; id: string } }>(
    "/api/projects/:slug/memory/:id/quarantine",
    async (request, reply) =>
      run(reply, () => {
        const engine = engineOf(request.params.slug);
        const body = parseBody(QuarantineBody, request.body);
        engine.quarantineCard(checkedId(request.params.id, "card"), body.note);
        return { ok: true };
      }),
  );

  // --------------------------------------------------------------- static UI

  app.setNotFoundHandler((request, reply) => {
    const url = (request.raw.url ?? "/").split("?")[0] ?? "/";
    if (uiDir === null || request.method !== "GET" || url.startsWith("/api/")) {
      void reply.code(404).send({ error: "not_found", detail: `no route for ${request.method} ${url}` });
      return;
    }
    const index = path.join(uiDir, "index.html");
    let file: string | null = null;
    try {
      const decoded = decodeURIComponent(url).replace(/^\/+/, "");
      const candidate = decoded === "" ? index : confine(uiDir, decoded);
      if (existsSync(candidate) && statSync(candidate).isFile()) file = candidate;
    } catch {
      file = null;
    }
    // SPA fallback: any unknown non-/api path renders the shell.
    const served = file ?? (existsSync(index) ? index : null);
    if (served === null) {
      void reply.code(404).send({ error: "not_found", detail: `no route for ${request.method} ${url}` });
      return;
    }
    void reply
      .type(CONTENT_TYPES[path.extname(served).toLowerCase()] ?? "application/octet-stream")
      .send(readFileSync(served));
  });

  return app;
}
