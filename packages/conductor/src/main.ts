import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerPool } from "./engine/pool.js";
import { MemoryService } from "./memory/service.js";
import { buildApp, SERVER_VERSION } from "./server/http.js";
import { EngineManager } from "./server/manager.js";

/**
 * Inventio conductor entrypoint (DESIGN §13). Boots the memory service, the
 * engine manager (opening every project on disk) and the HTTP control surface,
 * then shuts all three down cleanly on SIGINT/SIGTERM.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** packages/conductor/src → <workspace>/projects */
const DEFAULT_ROOT = path.resolve(HERE, "../../../projects");

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[inventio] ignoring ${name}="${raw}" (not a number); using ${fallback}`);
    return fallback;
  }
  return Math.floor(n);
}

export async function main(): Promise<void> {
  const host = process.env["HOST"] ?? "127.0.0.1";
  const port = envInt("PORT", 4700);
  const memoryPort = envInt("MEMORY_PORT", 4701);
  const root = path.resolve(process.env["INVENTIO_ROOT"] ?? DEFAULT_ROOT);
  const codexBin = process.env["INVENTIO_CODEX_BIN"] ?? "codex";
  const texBin = process.env["INVENTIO_TEX_BIN"] ?? "tectonic";
  const poolSize = envInt("INVENTIO_POOL", 8);
  const memoryDisabled = process.env["INVENTIO_DISABLE_MEMORY"] === "1";

  mkdirSync(root, { recursive: true });

  let memory: MemoryService | null = null;
  if (!memoryDisabled) {
    memory = new MemoryService({ host: "127.0.0.1", port: memoryPort });
    await memory.start();
  }

  const pool = new WorkerPool(poolSize);
  const manager = new EngineManager({
    root,
    codexBin,
    texBin,
    pool,
    memoryService: memory,
  });
  const app = buildApp(manager, { logger: false });
  try {
    manager.openAll();
    await app.listen({ host, port });
  } catch (error) {
    // A bind failure or a project owned by another process can happen during
    // a hot reload. Release every project lease acquired earlier in openAll()
    // before reporting the startup failure.
    await manager.shutdown();
    await memory?.stop();
    throw error;
  }

  const projects = manager.list();
  console.log(
    [
      ``,
      `  Inventio conductor ${SERVER_VERSION}`,
      `  ────────────────────────────────────────────`,
      `  API      http://${host}:${port}/api/health`,
      `  UI       http://${host}:${port}/`,
      `  memory   ${memory ? memory.url : "(disabled)"}`,
      `  root     ${root}`,
      `  codex    ${codexBin}   pool=${poolSize}`,
      `  TeX      ${manager.publicationCompiler.info().ok ? texBin : `${texBin} (unavailable)`}`,
      `  projects ${projects.length}${projects.length ? `: ${projects.map((p) => `${p.slug} [${p.phase}]`).join(", ")}` : ""}`,
      ``,
    ].join("\n"),
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[inventio] ${signal} — shutting down…`);
    try {
      await app.close();
      await manager.shutdown();
      await memory?.stop();
      console.log("[inventio] stopped cleanly.");
      process.exit(0);
    } catch (err) {
      console.error("[inventio] shutdown error:", err);
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error("[inventio] failed to start:", err);
  process.exit(1);
});
