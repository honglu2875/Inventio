import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ProjectConfig,
  SLUG_RE,
  defaultConfig,
  type ProjectState,
  type SourceMount,
} from "@inventio/schema";
import { ProjectEngine, type EngineDeps } from "../engine/engine.js";
import type { WorkerPool } from "../engine/pool.js";
import { FileMemoryBackend } from "../memory/cardStore.js";
import type { MemoryService } from "../memory/service.js";
import {
  listProjectSlugs,
  projectPaths,
  readProjectFile,
  writeProjectFile,
} from "../store/projectStore.js";
import {
  UPLOADS_MOUNT,
  deleteUpload,
  listUploads,
  resolveUpload,
  sanitizeUploadName,
  sourcesDir,
  writeUpload,
  type UploadedSource,
} from "./uploads.js";

/**
 * EngineManager (DESIGN §12): one `ProjectEngine` per project directory under
 * `root`, plus the memory wiring each engine needs. The HTTP layer owns no
 * project state of its own — everything it serves is derived from an engine.
 */

/** An error carrying the HTTP status the API should answer with. */
export class ManagerError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ManagerError";
    this.status = status;
  }
}

export interface EngineManagerOpts {
  root: string;
  codexBin: string;
  pool: WorkerPool;
  memoryService: MemoryService | null;
  /** test/dev overrides folded into every engine's deps */
  engineOverrides?: Partial<EngineDeps>;
}

export interface CreateProjectArgs {
  title: string;
  slug?: string;
  statement: string;
  contextMarkdown?: string;
  config?: unknown;
  /** Defaults to true for API compatibility; the UI defers until uploads finish. */
  start?: boolean;
}

export interface CloneIntakeArgs {
  title: string;
}

export interface ProjectSummary {
  slug: string;
  title: string;
  phase: ProjectState["phase"];
  paused: boolean;
  terminal: ProjectState["terminal"];
  autonomy: ProjectState["autonomy"];
  waves: number;
  budget: ProjectState["budget"];
  openBlockingQuestions: number;
  updatedAt: string | null;
}

/** title → slug: lowercase, non-alphanumerics to single hyphens, ≤64 chars. */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Shallow merge per top-level config key: `{ budget: { totalTokens } }` keeps
 * the other budget defaults, but a supplied array (e.g. sourceMounts) replaces.
 */
export function mergeConfig(patch: unknown): ProjectConfig {
  const base: Record<string, unknown> = { ...defaultConfig() };
  if (patch !== undefined && patch !== null) {
    if (!isPlainObject(patch)) throw new ManagerError("config must be an object", 400);
    for (const [key, value] of Object.entries(patch)) {
      const current = base[key];
      base[key] = isPlainObject(current) && isPlainObject(value) ? { ...current, ...value } : value;
    }
  }
  const parsed = ProjectConfig.safeParse(base);
  if (!parsed.success) {
    throw new ManagerError(
      `invalid config: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      400,
    );
  }
  return parsed.data;
}

export class EngineManager {
  readonly root: string;
  readonly codexBin: string;
  readonly pool: WorkerPool;
  private readonly memoryService: MemoryService | null;
  private readonly engineOverrides: Partial<EngineDeps>;
  private readonly engines = new Map<string, ProjectEngine>();

  constructor(opts: EngineManagerOpts) {
    this.root = opts.root;
    this.codexBin = opts.codexBin;
    this.pool = opts.pool;
    this.memoryService = opts.memoryService;
    this.engineOverrides = opts.engineOverrides ?? {};
  }

  private deps(): EngineDeps {
    const memory = this.memoryService;
    const deps: EngineDeps = {
      root: this.root,
      codexBin: this.codexBin,
      pool: this.pool,
      memory: memory
        ? {
            url: memory.url,
            mintToken: (scope) => memory.mintToken(scope),
            revokeToken: (token) => memory.revokeToken(token),
          }
        : null,
    };
    Object.assign(deps, this.engineOverrides);
    return deps;
  }

  /** Per-project memory backend: recalls land in that project's event log. */
  private wireMemory(engine: ProjectEngine): void {
    if (!this.memoryService) return;
    const backend = new FileMemoryBackend(engine.paths.dir, (rec) => engine.recordRecall(rec));
    this.memoryService.registerProject(engine.slug, backend);
  }

  createProject(args: CreateProjectArgs): ProjectEngine {
    const slug = args.slug ?? slugify(args.title);
    if (!SLUG_RE.test(slug)) {
      throw new ManagerError(
        `invalid slug "${slug}" (expected 2–64 chars matching ${String(SLUG_RE)})`,
        400,
      );
    }
    if (this.engines.has(slug) || existsSync(projectPaths(this.root, slug).projectFile)) {
      throw new ManagerError(`project ${slug} already exists`, 409);
    }
    const config = mergeConfig(args.config);
    const engine = ProjectEngine.create(this.deps(), {
      slug,
      title: args.title,
      statement: args.statement,
      contextMarkdown: args.contextMarkdown ?? "",
      config,
    });
    this.engines.set(slug, engine);
    this.wireMemory(engine);
    if (args.start ?? true) engine.start();
    return engine;
  }

  /**
   * Create a separate project containing the original intake materials and
   * W000, but none of the later research history. Project-local uploads are
   * part of the intake; external filesystem mounts are never inherited.
   */
  cloneIntake(sourceSlug: string, args: CloneIntakeArgs): ProjectEngine {
    const source = this.require(sourceSlug);
    const problemMarkdown =
      source.state.problem.confirmedMarkdown ?? source.state.problem.normalizedMarkdown;
    if (problemMarkdown === null) {
      throw new ManagerError(`project ${sourceSlug} has no completed intake to copy`, 409);
    }

    const title = args.title.trim();
    const comparable = (value: string): string =>
      value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
    if (title === "") throw new ManagerError("a new project title is required", 400);
    if (comparable(title) === comparable(source.state.title)) {
      throw new ManagerError("the fresh project must have a different title", 400);
    }

    const slug = slugify(title);
    if (!SLUG_RE.test(slug)) {
      throw new ManagerError(
        `invalid slug "${slug}" (expected 2–64 chars matching ${String(SLUG_RE)})`,
        400,
      );
    }
    if (slug === sourceSlug) {
      throw new ManagerError(
        "the fresh project must have a different title that produces a different project ID",
        400,
      );
    }
    if (this.engines.has(slug) || existsSync(projectPaths(this.root, slug).projectFile)) {
      throw new ManagerError(`project ${slug} already exists`, 409);
    }

    // Parsing makes a detached copy. External filesystem access is never
    // inherited; project-local uploads are copied below as ordinary bytes.
    const config = ProjectConfig.parse({
      ...source.state.config,
      autonomy: source.state.autonomy,
      sourceMounts: [],
    });
    const legacyDigest = source.state.problem.contextDigestMarkdown;
    const w000 = source.state.researchManagerNotes.find((note) => note.waveId === "W000");
    const engine = ProjectEngine.create(this.deps(), {
      slug,
      title,
      statement: source.state.statement,
      contextMarkdown: source.state.contextMarkdown,
      config,
    });
    for (const upload of listUploads(source.paths.dir)) {
      const file = path.join(sourcesDir(source.paths.dir), upload.name);
      writeUpload(engine.paths.dir, upload.name, readFileSync(file));
    }
    if (listUploads(engine.paths.dir).length > 0) this.syncUploadsMount(engine);
    engine.initializeFromIntakeClone(
      problemMarkdown,
      w000?.abstract ?? "",
      w000?.markdown.trim() || legacyDigest || problemMarkdown,
      source.state.problem.sources,
    );
    this.engines.set(slug, engine);
    this.wireMemory(engine);
    engine.start();
    return engine;
  }

  /** Load and start every project on disk (terminal ones just stay readable). */
  openAll(): void {
    for (const slug of listProjectSlugs(this.root)) {
      if (this.engines.has(slug)) continue;
      const engine = ProjectEngine.load(this.deps(), slug);
      this.engines.set(slug, engine);
      this.wireMemory(engine);
      // A loaded engine rebuilds its config from the event log, which predates
      // any upload; re-register the mount so earlier uploads stay reachable.
      if (existsSync(sourcesDir(engine.paths.dir))) this.syncUploadsMount(engine);
      engine.start();
    }
  }

  // ------------------------------------------------------- uploaded sources

  /**
   * Register (or refresh) the `uploads` source mount for a project, in the live
   * engine config and in `project.json`, so `grants.sourceMounts: ["uploads"]`
   * validates and the packet composer finds the directory.
   */
  private syncUploadsMount(engine: ProjectEngine): SourceMount {
    const dir = sourcesDir(engine.paths.dir);
    const mount: SourceMount = {
      name: UPLOADS_MOUNT,
      path: dir,
      note: "files supplied by the owner through the UI",
    };

    const live = engine.state.config.sourceMounts;
    const at = live.findIndex((m) => m.name === UPLOADS_MOUNT);
    if (at === -1) live.push(mount);
    else if (live[at]?.path !== dir) live[at] = mount;

    // project.json is the durable copy; the event log's config is immutable.
    try {
      const file = readProjectFile(engine.paths);
      const mounts = file.config.sourceMounts;
      const idx = mounts.findIndex((m) => m.name === UPLOADS_MOUNT);
      if (idx === -1) mounts.push(mount);
      else if (mounts[idx]?.path === dir) return mount;
      else mounts[idx] = mount;
      writeProjectFile(engine.paths, file);
    } catch {
      // A missing/unreadable project.json is a load-time problem, not an
      // upload-time one: the live mount above is what this run needs.
    }
    return mount;
  }

  /** Store one uploaded file and make sure the `uploads` mount exists. */
  uploadSource(slug: string, filename: string, data: Buffer): UploadedSource & { mount: string } {
    const engine = this.require(slug);
    if (engine.isRefreshingIntake()) {
      throw new ManagerError("source files cannot change while the Research Manager is reading the intake", 409);
    }
    const safeName = sanitizeUploadName(filename);
    const retained = engine.state.problem.sources.some(
      (source) => source.kind === "upload" && source.relativePath === path.posix.join("sources", safeName),
    );
    if (
      retained &&
      existsSync(path.join(sourcesDir(engine.paths.dir), safeName)) &&
      !engine.canReviseRawIntake()
    ) {
      throw new ManagerError(
        `${safeName} is part of the retained intake and cannot be replaced; upload a new version under a different name`,
        409,
      );
    }
    const stored = writeUpload(engine.paths.dir, filename, data);
    const mount = this.syncUploadsMount(engine);
    if (engine.canReviseRawIntake()) engine.refreshRawIntakeSources();
    return { ...stored, mount: mount.name };
  }

  listSources(slug: string): UploadedSource[] {
    return listUploads(this.require(slug).paths.dir);
  }

  readSource(slug: string, name: string): { name: string; data: Buffer } {
    const engine = this.require(slug);
    const resolved = resolveUpload(engine.paths.dir, name);
    if (!existsSync(resolved.file)) throw new ManagerError(`unknown source file ${resolved.name}`, 404);
    return { name: resolved.name, data: readFileSync(resolved.file) };
  }

  deleteSource(slug: string, name: string): void {
    const engine = this.require(slug);
    if (engine.isRefreshingIntake()) {
      throw new ManagerError("source files cannot change while the Research Manager is reading the intake", 409);
    }
    const safeName = sanitizeUploadName(name);
    const retained = engine.state.problem.sources.some(
      (source) => source.kind === "upload" && source.relativePath === path.posix.join("sources", safeName),
    );
    if (retained && !engine.canReviseRawIntake()) {
      throw new ManagerError(
        `${safeName} is part of the retained intake and cannot be deleted`,
        409,
      );
    }
    deleteUpload(engine.paths.dir, safeName);
    if (engine.canReviseRawIntake()) engine.refreshRawIntakeSources();
  }

  get(slug: string): ProjectEngine | undefined {
    return this.engines.get(slug);
  }

  /** Throwing accessor for the HTTP layer. */
  require(slug: string): ProjectEngine {
    const engine = this.engines.get(slug);
    if (!engine) throw new ManagerError(`unknown project ${slug}`, 404);
    return engine;
  }

  list(): ProjectSummary[] {
    return [...this.engines.values()]
      .map((engine) => {
        const s = engine.state;
        return {
          slug: engine.slug,
          title: s.title,
          phase: s.phase,
          paused: s.paused,
          terminal: s.terminal,
          autonomy: s.autonomy,
          waves: s.waveOrder.length,
          budget: s.budget,
          openBlockingQuestions: Object.values(s.questions).filter(
            (question) => question.status === "open" && question.blocking,
          ).length,
          updatedAt: engine.events.at(-1)?.ts ?? null,
        };
      })
      .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  }

  async shutdown(): Promise<void> {
    const engines = [...this.engines.values()];
    this.engines.clear();
    await Promise.all(
      engines.map(async (engine) => {
        try {
          await engine.stop();
        } finally {
          this.memoryService?.unregisterProject(engine.slug);
        }
      }),
    );
  }
}
