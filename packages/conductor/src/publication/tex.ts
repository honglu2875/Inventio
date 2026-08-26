import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { PublicationOutput } from "@inventio/schema";

/**
 * Local TeX compilation boundary. The Research Manager supplies mathematical
 * TeX fragments; deterministic code supplies the preamble and invokes
 * Tectonic in its explicit untrusted mode.
 */

export interface TexCompilerInfo {
  bin: string;
  ok: boolean;
  version: string | null;
  detail: string | null;
}

export interface TexCompileRequest {
  texPath: string;
  outputDir: string;
  wallClockMs?: number;
  registerKill?: (kill: () => void) => void;
}

export interface TexCompileResult {
  compiler: string;
  pdfPath: string;
  log: string;
}

export interface PublicationCompiler {
  info(): TexCompilerInfo;
  compile(request: TexCompileRequest): Promise<TexCompileResult>;
}

const DEFAULT_COMPILE_TIMEOUT_MS = 3 * 60_000;
const LOG_LIMIT = 120_000;

export function createTectonicCompiler(bin = "tectonic"): PublicationCompiler {
  return {
    info: () => probeTectonic(bin),
    compile: (request) => compileWithTectonic(bin, request),
  };
}

export function probeTectonic(bin: string): TexCompilerInfo {
  try {
    const result = spawnSync(bin, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
    });
    const output = String(result.stdout ?? "") + String(result.stderr ?? "");
    const clean = output.trim();
    if (result.error || result.status !== 0) {
      return {
        bin,
        ok: false,
        version: null,
        detail:
          result.error?.message ??
          (clean || bin + " exited " + String(result.status)),
      };
    }
    return {
      bin,
      ok: true,
      version: clean.split("\n")[0]?.trim() || null,
      detail: null,
    };
  } catch (error) {
    return {
      bin,
      ok: false,
      version: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function compileWithTectonic(
  bin: string,
  request: TexCompileRequest,
): Promise<TexCompileResult> {
  mkdirSync(request.outputDir, { recursive: true });
  const expectedPdf = path.join(
    request.outputDir,
    path.basename(request.texPath, path.extname(request.texPath)) + ".pdf",
  );
  const args = [
    "-X",
    "compile",
    "--untrusted",
    "--keep-logs",
    "--outdir",
    request.outputDir,
    request.texPath,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: request.outputDir,
      env: {
        ...process.env,
        // Defense in depth: Tectonic honors this even if a future CLI change
        // accidentally drops the explicit --untrusted argument above.
        TECTONIC_UNTRUSTED_MODE: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let spawnError: Error | null = null;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    let wallTimer: NodeJS.Timeout | null = null;

    const append = (chunk: Buffer): void => {
      output = (output + chunk.toString("utf8")).slice(-LOG_LIMIT);
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (error) => {
      spawnError = error;
    });

    const kill = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGINT");
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 2_000);
    };
    request.registerKill?.(kill);
    wallTimer = setTimeout(() => {
      timedOut = true;
      kill();
    }, request.wallClockMs ?? DEFAULT_COMPILE_TIMEOUT_MS);

    child.on("close", (code) => {
      if (wallTimer) clearTimeout(wallTimer);
      if (killTimer) clearTimeout(killTimer);
      const log = [
        "$ " + bin + " " + args.map(shellDisplay).join(" "),
        "",
        output.trim(),
      ].join("\n");
      if (timedOut) {
        reject(Object.assign(new Error("TeX compilation timed out"), { compileLog: log }));
        return;
      }
      if (spawnError || code !== 0) {
        const detail = spawnError?.message ?? "Tectonic exited with status " + String(code);
        reject(Object.assign(new Error(detail), { compileLog: log }));
        return;
      }
      if (!existsSync(expectedPdf)) {
        reject(
          Object.assign(new Error("Tectonic completed without producing a PDF"), {
            compileLog: log,
          }),
        );
        return;
      }
      const header = readFileSync(expectedPdf).subarray(0, 5).toString("ascii");
      if (header !== "%PDF-") {
        reject(
          Object.assign(new Error("the TeX compiler output is not a valid PDF"), {
            compileLog: log,
          }),
        );
        return;
      }
      const version = probeTectonic(bin).version;
      resolve({
        compiler: version ?? bin,
        pdfPath: expectedPdf,
        log,
      });
    });
  });
}

function shellDisplay(value: string): string {
  return /^[A-Za-z0-9_./:=+-]+$/.test(value)
    ? value
    : "'" + value.replace(/'/g, "'\\''") + "'";
}

function escapeTexText(value: string): string {
  return value
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([{}$&#_%])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

const FORBIDDEN_TEX = [
  /\\(?:documentclass|usepackage|RequirePackage)\b|\\(?:begin|end)\s*\{document\}/i,
  /\\[A-Za-z@]*input[A-Za-z@]*\b/i,
  /\\(?:include|includeonly|includegraphics|bibliography|bibliographystyle|lstinputlisting|verbatiminput)\b/i,
  /\\(?:write18|write|read|openin|openout|newread|newwrite|immediate|special)\b/i,
  /\\(?:catcode|csname|endcsname|directlua|pdfshellescape|ShellEscape)\b/i,
  /\\begin\s*\{(?:filecontents\*?|comment)\}/i,
] as const;

function regexpEscape(value: string): string {
  return value.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

/**
 * Reject document-boundary/file-I/O TeX and internal asset labels before a
 * compiler sees the manuscript. Tectonic's untrusted mode is still enabled;
 * this check also keeps project terminology out of the public document.
 */
export function validatePublicationManuscript(
  output: PublicationOutput,
  internalIds: Iterable<string>,
): string[] {
  const errors: string[] = [];
  const publicText = output.title + "\n" + output.abstractTex + "\n" + output.bodyTex;
  if (/\bInventio\b/i.test(publicText)) {
    errors.push("the standalone manuscript must not mention Inventio");
  }
  for (const pattern of FORBIDDEN_TEX) {
    const match = pattern.exec(output.abstractTex + "\n" + output.bodyTex);
    if (match) errors.push("manuscript contains forbidden TeX command " + match[0]);
  }
  for (const id of new Set(internalIds)) {
    if (id.trim() === "") continue;
    const candidateSuffixGuard = /\.v\d+$/.test(id) ? "" : "(?!\\.v\\d)";
    const pattern = new RegExp(
      "(^|[^A-Za-z0-9_-])" +
        regexpEscape(id) +
        candidateSuffixGuard +
        "(?=$|[^A-Za-z0-9_-])",
      "m",
    );
    if (pattern.test(publicText)) {
      errors.push("standalone manuscript still contains internal label " + id);
      if (errors.length >= 12) break;
    }
  }
  return errors;
}

/** Wrap Manager-authored TeX fragments in Inventio's fixed academic preamble. */
export function renderPublicationTex(output: PublicationOutput): string {
  const title = escapeTexText(output.title);
  return [
    "\\documentclass[11pt]{article}",
    "\\usepackage[T1]{fontenc}",
    "\\usepackage{lmodern}",
    "\\usepackage[margin=1in]{geometry}",
    "\\usepackage{amsmath,amssymb,amsthm,mathtools}",
    "\\usepackage{microtype}",
    "\\usepackage[hidelinks]{hyperref}",
    "",
    "\\newtheorem{theorem}{Theorem}[section]",
    "\\newtheorem{proposition}[theorem]{Proposition}",
    "\\newtheorem{lemma}[theorem]{Lemma}",
    "\\newtheorem{corollary}[theorem]{Corollary}",
    "\\theoremstyle{definition}",
    "\\newtheorem{definition}[theorem]{Definition}",
    "\\newtheorem{example}[theorem]{Example}",
    "\\theoremstyle{remark}",
    "\\newtheorem{remark}[theorem]{Remark}",
    "\\allowdisplaybreaks",
    "",
    "\\title{" + title + "}",
    "\\date{}",
    "",
    "\\begin{document}",
    "\\maketitle",
    "",
    "\\begin{abstract}",
    output.abstractTex.trim(),
    "\\end{abstract}",
    "",
    output.bodyTex.trim(),
    "",
    "\\end{document}",
    "",
  ].join("\n");
}
