import { describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PublicationOutput } from "@inventio/schema";
import {
  createTectonicCompiler,
  renderPublicationTex,
  validatePublicationManuscript,
} from "../src/publication/tex.js";

function report(over: Partial<PublicationOutput> = {}): PublicationOutput {
  return {
    kind: "research_report",
    result: "UNCERTAIN",
    title: "A Partial Result for X & Y",
    abstractTex: "We prove a partial theorem.",
    bodyTex:
      "\\section{Main result}\n\\begin{proposition}The reduction holds.\\end{proposition}",
    assessment: "One implication remains open.",
    ...over,
  } as PublicationOutput;
}

describe("standalone TeX publications", () => {
  it("wraps mathematical fragments in the fixed article document", () => {
    const tex = renderPublicationTex(report());
    expect(tex).toContain("\\documentclass[11pt]{article}");
    expect(tex).toContain("\\title{A Partial Result for X \\& Y}");
    expect(tex).toContain("\\begin{abstract}\nWe prove a partial theorem.\n\\end{abstract}");
    expect(tex).toContain("\\newtheorem{proposition}[theorem]{Proposition}");
    expect(tex.trimEnd().endsWith("\\end{document}")).toBe(true);
  });

  it("rejects private project labels, product references, and file-reading TeX", () => {
    const errors = validatePublicationManuscript(
      report({
        abstractTex: "Inventio recorded the argument as C001.v1.",
        bodyTex: "\\input{/etc/passwd}\n\\begin{document}Injected text",
      }),
      ["W000", "C001", "C001.v1", "A001"],
    );
    expect(errors.join("\n")).toContain("must not mention Inventio");
    expect(errors.join("\n")).toContain("internal label C001.v1");
    expect(errors.join("\n")).toContain("forbidden TeX command \\input");
    expect(errors.join("\n")).toContain("forbidden TeX command \\begin{document}");
  });

  it("invokes the local compiler in explicit untrusted mode and verifies its PDF", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "inventio-tex-boundary-"));
    const bin = path.join(dir, "fake-tectonic.mjs");
    const source = path.join(dir, "manuscript.tex");
    const out = path.join(dir, "out");
    writeFileSync(source, "\\documentclass{article}\\begin{document}x\\end{document}\n");
    writeFileSync(
      bin,
      [
        "#!/usr/bin/env node",
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import path from 'node:path';",
        "const args = process.argv.slice(2);",
        "if (args[0] === '--version') { console.log('Tectonic test 1.0'); process.exit(0); }",
        "const outdir = args[args.indexOf('--outdir') + 1];",
        "const input = args.at(-1);",
        "mkdirSync(outdir, { recursive: true });",
        "writeFileSync(path.join(outdir, 'argv.json'), JSON.stringify(args));",
        "writeFileSync(path.join(outdir, path.basename(input, path.extname(input)) + '.pdf'), '%PDF-1.4\\n');",
      ].join("\n"),
    );
    chmodSync(bin, 0o755);

    const compiler = createTectonicCompiler(bin);
    expect(compiler.info()).toMatchObject({ ok: true, version: "Tectonic test 1.0" });
    const result = await compiler.compile({ texPath: source, outputDir: out });
    expect(readFileSync(result.pdfPath).subarray(0, 5).toString("ascii")).toBe("%PDF-");
    const argv = JSON.parse(readFileSync(path.join(out, "argv.json"), "utf8")) as string[];
    expect(argv.slice(0, 2)).toEqual(["-X", "compile"]);
    expect(argv).toContain("--untrusted");
    expect(argv).toContain("--keep-logs");
  });
});
