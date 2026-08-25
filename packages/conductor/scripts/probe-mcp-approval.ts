/**
 * Probe: which `mcp_servers.<name>.approval_mode` value lets a sandboxed
 * `codex exec` worker actually call our memory tools?
 *
 * The first real research run showed every memory_search failing with
 * "MCP tool call requires approval, but approval policy is never", i.e. the
 * entire on-demand recall layer (PROTOCOL §7) was dead in practice.
 *
 *   npx tsx packages/conductor/scripts/probe-mcp-approval.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { MemoryService } from "../src/memory/service.js";
import { CardStore, FileMemoryBackend } from "../src/memory/cardStore.js";

/**
 * Each variant is a different way of asking Codex to let a sandboxed worker
 * call an MCP tool. `extra` is appended to the argv.
 */
const VARIANTS: { name: string; sandbox: string; extra: string[] }[] = [
  { name: "read-only/default", sandbox: "read-only", extra: [] },
  { name: "workspace-write", sandbox: "workspace-write", extra: [] },
  { name: "read-only/approve-for-me", sandbox: "read-only", extra: ["--approve-for-me"] },
  { name: "enabled_tools allowlist", sandbox: "read-only", extra: [
    "-c", 'mcp_servers.memory.enabled_tools=["memory_search","memory_expand"]',
  ] },
];
const PORT = Number(process.env["PROBE_PORT"] ?? 4795);

async function main(): Promise<void> {
  const root = mkdtempSync(path.join(os.tmpdir(), "mcp-probe-"));
  const cardsDir = path.join(root, "memory", "cards");
  mkdirSync(cardsDir, { recursive: true });
  new CardStore(cardsDir).write({
    id: "M001",
    type: "LEMMA",
    status: "VERIFIED",
    title: "Probe lemma",
    abstract: "A distinctive marker phrase for the probe.",
    content: "The probe marker is BANANAPHONE-7731.",
    tags: ["probe"],
    provenance: "probe fixture",
    sourceArtifact: null,
    dependsOn: [],
  });

  const service = new MemoryService({ port: PORT });
  await service.start();
  const recalls: string[] = [];
  service.registerProject("probe", new FileMemoryBackend(root, (r) => recalls.push(r.op)));
  console.log(`memory service at ${service.url}\n`);

  const results: { mode: string; called: boolean; sawMarker: boolean; error: string }[] = [];

  for (const variant of VARIANTS) {
    const mode = variant.name;
    const token = service.mintToken({ slug: "probe", taskId: "T001", role: "solver", waveId: "W001" });
    const dir = mkdtempSync(path.join(os.tmpdir(), `probe-${mode.replace(/\W+/g, "-")}-`));
    writeFileSync(
      path.join(dir, "AGENTS.md"),
      "Call the memory_search tool with query 'probe', then memory_expand on any id it returns, " +
        "then reply with the exact marker string you found.",
    );
    const before = recalls.length;
    const res = spawnSync(
      "codex",
      [
        "exec", "--json", "--ignore-user-config", "--skip-git-repo-check",
        "-C", dir, "-s", variant.sandbox,
        "-c", `model_reasoning_effort="low"`,
        "-c", `mcp_servers.memory={url="${service.url}",bearer_token_env_var="INVENTIO_TASK_TOKEN"}`,
        ...variant.extra,
        "-",
      ],
      {
        input: "Follow AGENTS.md. Report the marker string.",
        encoding: "utf8",
        timeout: 120_000,
        env: { ...process.env, INVENTIO_TASK_TOKEN: token },
      },
    );
    const out = (res.stdout ?? "") + (res.stderr ?? "");
    const errMatch = /"message":"([^"]*approval[^"]*)"/i.exec(out);
    results.push({
      mode,
      called: recalls.length > before,
      sawMarker: out.includes("BANANAPHONE-7731"),
      error: errMatch?.[1] ?? (/"error":\{"message":"([^"]*)"/.exec(out)?.[1] ?? ""),
    });
    service.revokeToken(token);
    console.log(`${mode.padEnd(9)} tool-call-reached-server=${results.at(-1)!.called} marker=${results.at(-1)!.sawMarker} ${results.at(-1)!.error.slice(0, 90)}`);
  }

  await service.stop();
  console.log("\n=== summary ===");
  const win = results.find((r) => r.called && r.sawMarker);
  console.log(win ? `USE approval_mode="${win.mode}"` : "NONE of the probed values worked — memory must move into the packet as files");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
