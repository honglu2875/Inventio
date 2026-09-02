import { describe, expect, it } from "vitest";
import { parseModelJson, protectModelJsonTex } from "../src/codex/modelJson.js";

describe("model JSON TeX integrity", () => {
  it("preserves the exact formula that exposed the form-feed corruption", () => {
    const raw = String.raw`{"artifactMarkdown":"$C_{rs}:=\frac{\\langle\tau_r(\\alpha),\\tau_s(\\beta)\\rangle_{0,2,r+s+1}}{\\Omega(\\alpha,\\beta)} =\frac{(-24)^{r+s+1}}{r!s!(r+s+1)}. \tag{7.1}$"}`;
    const parsed = parseModelJson(raw) as { artifactMarkdown: string };

    expect(parsed.artifactMarkdown).toBe(
      String.raw`$C_{rs}:=\frac{\langle\tau_r(\alpha),\tau_s(\beta)\rangle_{0,2,r+s+1}}{\Omega(\alpha,\beta)} =\frac{(-24)^{r+s+1}}{r!s!(r+s+1)}. \tag{7.1}$`,
    );
    expect(parsed.artifactMarkdown).not.toMatch(/[\b\f\r\t]/);
  });

  it("repairs every legal control-prefix family without touching valid JSON newlines", () => {
    const raw = String.raw`{"math":"\beta+\frac{1}{2}+\nabla f+\rho+\tau+\text{x}","prose":"first\ntext on the next line"}`;
    const parsed = parseModelJson(raw) as { math: string; prose: string };

    expect(parsed.math).toBe(String.raw`\beta+\frac{1}{2}+\nabla f+\rho+\tau+\text{x}`);
    expect(parsed.prose).toBe("first\ntext on the next line");
  });

  it("does not turn a display line break before an exponential into \\ne", () => {
    const raw = String.raw`{"proof":"Expand\n\\[\nA=\ne^{\\delta D}-2\n\\]\nDone."}`;
    const parsed = parseModelJson(raw) as { proof: string };

    expect(parsed.proof).toBe("Expand\n\\[\nA=\ne^{\\delta D}-2\n\\]\nDone.");
    expect(parsed.proof).not.toContain(String.raw`A=\ne^`);
  });

  it("does not turn a display line break before an ordinary u into Greek nu", () => {
    const raw = String.raw`{"proof":"Define\n\\[\nA=\nu=(\\Lambda-1)F_t.\n\\]"}`;
    const parsed = parseModelJson(raw) as { proof: string };

    expect(parsed.proof).toBe("Define\n\\[\nA=\nu=(\\Lambda-1)F_t.\n\\]");
    expect(parsed.proof).not.toContain(String.raw`A=\nu=`);
  });

  it("preserves properly escaped Greek nu and not-equal commands", () => {
    const raw = JSON.stringify({ proof: String.raw`\[\nu\ne0\]` });
    expect(parseModelJson(raw)).toEqual({ proof: String.raw`\[\nu\ne0\]` });
  });

  it("leaves correctly doubled TeX escapes byte-stable", () => {
    const raw = JSON.stringify({ math: String.raw`\frac{\theta}{\rho}` });
    expect(protectModelJsonTex(raw)).toBe(raw);
    expect(parseModelJson(raw)).toEqual({ math: String.raw`\frac{\theta}{\rho}` });
  });

  it("rejects an unrecognized form feed instead of silently persisting it", () => {
    expect(() => parseModelJson(String.raw`{"text":"bad\fizz"}`)).toThrow(
      /ambiguous control escape/,
    );
  });

  it("rejects every unexplained C0/C1 control family before persistence", () => {
    for (const escaped of ["\\u0001", "\\u0002", "\\u0007", "\\u000b", "\\u007f", "\\u0085"]) {
      expect(() => parseModelJson(`{"text":"before${escaped}after"}`)).toThrow(
        /forbidden control U\+/,
      );
    }
  });

  it("continues to allow ordinary escaped textual whitespace", () => {
    expect(parseModelJson(String.raw`{"text":"a\tb\nc\rd"}`)).toEqual({ text: "a\tb\nc\rd" });
  });
});
