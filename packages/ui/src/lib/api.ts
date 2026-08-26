import { Memo as MemoSchema } from "@inventio/schema";
import type {
  ActiveModelSettings,
  ArtifactKind,
  ClaimStatus,
  IssueSeverity,
  IntakeMemory,
  Memo,
  ProjectSettings,
  ProjectState,
  Result,
  TaskState,
} from "@inventio/schema";

/**
 * Typed fetch helpers for the conductor control surface (DESIGN §12).
 * Every failure — transport, HTTP status, or malformed body — surfaces as an
 * `ApiError` whose `message` is toast-ready.
 */

export const API_BASE = "/api";

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

type Method = "GET" | "POST" | "DELETE";

interface SendOptions {
  body?: BodyInit;
  headers?: Record<string, string>;
  /** Return the raw text instead of parsing JSON. */
  asText?: boolean;
}

async function send<T>(method: Method, path: string, options: SendOptions = {}): Promise<T> {
  const { body, headers, asText = false } = options;
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers: headers ?? {},
      ...(body === undefined ? {} : { body }),
    });
  } catch (err) {
    throw new ApiError(`network error: ${err instanceof Error ? err.message : String(err)}`, 0);
  }

  const raw = await response.text();
  if (!response.ok) {
    let detail = raw.slice(0, 400);
    try {
      const parsed = JSON.parse(raw) as { error?: string; detail?: string };
      detail = parsed.detail ?? parsed.error ?? detail;
    } catch {
      /* non-JSON error body: keep the raw text */
    }
    throw new ApiError(detail || `${method} ${path} failed (${response.status})`, response.status);
  }
  if (asText) return raw as unknown as T;
  if (raw === "") return undefined as unknown as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ApiError(`malformed JSON from ${path}`, 500);
  }
}

function request<T>(method: Method, path: string, body?: unknown, asText = false): Promise<T> {
  return send<T>(method, path, {
    ...(body === undefined
      ? {}
      : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    asText,
  });
}

// ------------------------------------------------------------------- shapes

export interface ProjectSummary {
  slug: string;
  title: string;
  phase: ProjectState["phase"];
  paused: boolean;
  terminal: { result: Result; finalPath: string } | null;
  autonomy: "auto" | "gated";
  waves: number;
  budget: ProjectState["budget"];
  openBlockingQuestions: number;
  updatedAt: string | null;
}

export interface RuntimeInfo {
  codex: { bin: string; version: string | null; ok: boolean };
  tex?: { bin: string; version: string | null; ok: boolean; detail: string | null };
  pool: { active: number; queued: number };
  projects: number;
}

export interface HealthInfo {
  ok: boolean;
  version: string;
  root: string;
  codexBin: string;
}

export interface Snapshot {
  state: ProjectState;
  seq: number;
}

export interface ArtifactBody {
  id: string;
  kind: ArtifactKind;
  conclusion: string | null;
  path: string;
  markdown: string;
}

export interface TaskDetail {
  task: TaskState;
  packetManifest: string[];
  memo: Memo | null;
  meta: Record<string, unknown> | null;
}

interface TaskDetailWire extends Omit<TaskDetail, "memo"> {
  /** Unknown at the transport boundary; older servers returned the whole output here. */
  memo: unknown;
}

/** Accept the corrected response and the one-level-too-deep legacy response. */
export function decodeTaskMemo(raw: unknown): Memo | null {
  const direct = MemoSchema.safeParse(raw);
  if (direct.success) return direct.data;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const nested = MemoSchema.safeParse((raw as Record<string, unknown>)["memo"]);
  return nested.success ? nested.data : null;
}

export interface CreateProjectBody {
  title: string;
  statement: string;
  contextMarkdown?: string;
  slug?: string;
  config?: unknown;
  start?: boolean;
}

/** A file the owner supplied, stored under `projects/<slug>/sources/`. */
export interface SourceFile {
  name: string;
  size: number;
  uploadedAt: string;
}

export interface UploadedSource extends SourceFile {
  /** The source mount the file became reachable through ("uploads"). */
  mount: string;
}

/** Per-file cap enforced by the conductor (10 MB). */
export const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
/**
 * Packets skip mount files larger than this, so a bigger upload is stored but
 * never reaches a worker (`engine/packets.ts`).
 */
export const PACKET_SOURCE_LIMIT = 5 * 1024 * 1024;

// ------------------------------------------------------------------- routes

const enc = encodeURIComponent;

export const api = {
  // reads
  health: (): Promise<HealthInfo> => request("GET", "/health"),
  runtime: (): Promise<RuntimeInfo> => request("GET", "/runtime"),
  listProjects: (): Promise<ProjectSummary[]> => request("GET", "/projects"),
  snapshot: (slug: string): Promise<Snapshot> => request("GET", `/projects/${enc(slug)}`),
  artifact: (slug: string, id: string): Promise<ArtifactBody> =>
    request("GET", `/projects/${enc(slug)}/artifacts/${enc(id)}`),
  task: async (slug: string, id: string): Promise<TaskDetail> => {
    const detail = await request<TaskDetailWire>("GET", `/projects/${enc(slug)}/tasks/${enc(id)}`);
    return { ...detail, memo: decodeTaskMemo(detail.memo) };
  },
  packetFile: (slug: string, id: string, path: string): Promise<string> =>
    request(
      "GET",
      `/projects/${enc(slug)}/tasks/${enc(id)}/packet/${path.split("/").map(enc).join("/")}`,
      undefined,
      true,
    ),

  // lifecycle
  createProject: (body: CreateProjectBody): Promise<{ slug: string }> =>
    request("POST", "/projects", body),
  cloneIntake: (slug: string, title: string): Promise<{ slug: string; phase: string }> =>
    request("POST", `/projects/${enc(slug)}/clone-intake`, { title }),
  updateRawIntake: (
    slug: string,
    statement: string,
    contextMarkdown: string,
  ): Promise<{ ok: true; phase: string }> =>
    request("POST", `/projects/${enc(slug)}/raw-intake`, { statement, contextMarkdown }),
  confirmProblem: (
    slug: string,
    problemMarkdown: string,
    contextDigestMarkdown?: string,
    rawMemories?: IntakeMemory[],
    managerAbstract?: string,
    managerNoteMarkdown?: string,
  ): Promise<{ ok: true; phase: string }> =>
    request("POST", `/projects/${enc(slug)}/confirm-problem`, {
      problemMarkdown,
      ...(contextDigestMarkdown === undefined ? {} : { contextDigestMarkdown }),
      ...(rawMemories === undefined ? {} : { rawMemories }),
      ...(managerAbstract === undefined ? {} : { managerAbstract }),
      ...(managerNoteMarkdown === undefined ? {} : { managerNoteMarkdown }),
    }),
  regenerateIntake: (slug: string): Promise<{ ok: true; phase: string }> =>
    request("POST", `/projects/${enc(slug)}/regenerate-intake`),
  start: (slug: string): Promise<{ ok: true; phase: string }> =>
    request("POST", `/projects/${enc(slug)}/start`),
  pause: (slug: string): Promise<{ ok: true; paused: boolean }> =>
    request("POST", `/projects/${enc(slug)}/pause`),
  resume: (slug: string): Promise<{ ok: true; paused: boolean }> =>
    request("POST", `/projects/${enc(slug)}/resume`),
  continueResearch: (
    slug: string,
    note: string,
    addTokens: number,
    addWaves: number,
    humanRevisionMarkdown?: string,
  ): Promise<{ ok: true; phase: string; totalTokens: number; maxWaves: number }> =>
    request("POST", `/projects/${enc(slug)}/continue`, {
      note,
      addTokens,
      addWaves,
      ...(humanRevisionMarkdown === undefined ? {} : { humanRevisionMarkdown }),
    }),
  preparePublication: (
    slug: string,
  ): Promise<{ ok: true; publicationId: string; status: string }> =>
    request("POST", `/projects/${enc(slug)}/publication`),
  setAutonomy: (slug: string, mode: "auto" | "gated"): Promise<{ ok: true; autonomy: string }> =>
    request("POST", `/projects/${enc(slug)}/autonomy`, { mode }),
  projectSettings: (slug: string): Promise<{ settings: ProjectSettings }> =>
    request("GET", `/projects/${enc(slug)}/settings`),
  setProjectSettings: (
    slug: string,
    settings: ProjectSettings,
  ): Promise<{ ok: true; settings: ProjectSettings }> =>
    request("POST", `/projects/${enc(slug)}/settings`, settings),
  setWebSearch: (slug: string, enabled: boolean): Promise<{ ok: true; enabled: boolean }> =>
    request("POST", `/projects/${enc(slug)}/web-search`, { enabled }),
  setModelSettings: (
    slug: string,
    models: ActiveModelSettings,
  ): Promise<{ ok: true; models: ActiveModelSettings }> =>
    request("POST", `/projects/${enc(slug)}/models`, models),

  // owner-supplied sources (drag-and-drop files; DESIGN §12)
  listSources: (slug: string): Promise<SourceFile[]> =>
    request("GET", `/projects/${enc(slug)}/sources`),
  /**
   * The conductor has no multipart parser: the file goes up as a raw body with
   * its name in `x-filename` (percent-encoded — headers are latin-1).
   */
  uploadSource: (slug: string, file: File): Promise<UploadedSource> =>
    send("POST", `/projects/${enc(slug)}/sources`, {
      body: file,
      headers: {
        "content-type": "application/octet-stream",
        "x-filename": encodeURIComponent(file.name),
      },
    }),
  deleteSource: (slug: string, name: string): Promise<{ ok: true }> =>
    request("DELETE", `/projects/${enc(slug)}/sources/${enc(name)}`),

  // steering
  submitDirective: (slug: string, text: string, urgent: boolean): Promise<{ id: string }> =>
    request("POST", `/projects/${enc(slug)}/directives`, { text, urgent }),
  answerQuestion: (slug: string, id: string, answer: string): Promise<{ ok: true }> =>
    request("POST", `/projects/${enc(slug)}/questions/${enc(id)}/answer`, { answer }),
  dismissQuestion: (slug: string, id: string): Promise<{ ok: true }> =>
    request("POST", `/projects/${enc(slug)}/questions/${enc(id)}/dismiss`),
  resolveGate: (
    slug: string,
    decisionId: string,
    resolution: "approve" | "edit" | "reject",
    action?: unknown,
    note?: string,
  ): Promise<{ ok: true }> =>
    request("POST", `/projects/${enc(slug)}/gates/${enc(decisionId)}`, {
      resolution,
      ...(action === undefined ? {} : { action }),
      ...(note === undefined ? {} : { note }),
    }),
  interruptWave: (slug: string, waveId: string): Promise<{ ok: true }> =>
    request("POST", `/projects/${enc(slug)}/waves/${enc(waveId)}/interrupt`),
  interruptTask: (slug: string, taskId: string): Promise<{ ok: true }> =>
    request("POST", `/projects/${enc(slug)}/tasks/${enc(taskId)}/interrupt`),
  extendTask: (slug: string, taskId: string, addTokens: number): Promise<{ ok: true }> =>
    request("POST", `/projects/${enc(slug)}/tasks/${enc(taskId)}/extend`, { addTokens }),

  // ledger interventions
  setClaimStatus: (
    slug: string,
    claimId: string,
    to: Extract<ClaimStatus, "VERIFIED" | "REFUTED">,
    note: string,
  ): Promise<{ ok: true }> =>
    request("POST", `/projects/${enc(slug)}/claims/${enc(claimId)}/status`, { to, note }),
  raiseIssue: (
    slug: string,
    candidateId: string,
    severity: IssueSeverity,
    location: string,
    text: string,
  ): Promise<{ issueId: string }> =>
    request("POST", `/projects/${enc(slug)}/issues`, { candidateId, severity, location, text }),
  quarantineCard: (slug: string, cardId: string, note: string): Promise<{ ok: true }> =>
    request("POST", `/projects/${enc(slug)}/memory/${enc(cardId)}/quarantine`, { note }),
};

export function publicationPdfUrl(slug: string, publicationId: string): string {
  return (
    API_BASE +
    "/projects/" +
    enc(slug) +
    "/publications/" +
    enc(publicationId) +
    "/pdf"
  );
}

// -------------------------------------------------- artifact body cache (§10)

interface CachedArtifact {
  seq: number;
  body: ArtifactBody;
}

const artifactCache = new Map<string, CachedArtifact>();

/**
 * Artifact bodies are fetched on demand and cached by id; a newer
 * `artifact.recorded` for the same id (a higher `recordedAtSeq`) invalidates
 * the entry (UI-SPEC §10).
 */
export async function loadArtifact(
  slug: string,
  id: string,
  recordedAtSeq: number,
): Promise<ArtifactBody> {
  const key = `${slug}:${id}`;
  const hit = artifactCache.get(key);
  if (hit && hit.seq >= recordedAtSeq) return hit.body;
  const body = await api.artifact(slug, id);
  artifactCache.set(key, { seq: recordedAtSeq, body });
  return body;
}

export function clearArtifactCache(): void {
  artifactCache.clear();
}
