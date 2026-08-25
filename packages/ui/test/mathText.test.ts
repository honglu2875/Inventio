import { describe, expect, it } from "vitest";
import katex from "katex";
import { normalizeTex, splitMath, stripMath } from "../src/lib/mathText.js";

/**
 * Delimiter normalization (UI-SPEC §1). DOM-free: the scanner is pure string
 * work, and every case here is one the models actually produce.
 */

/** Every conversion must survive a second pass unchanged. */
function idempotent(src: string): string {
  const once = normalizeTex(src);
  expect(normalizeTex(once)).toBe(once);
  return once;
}

describe("normalizeTex — inline math", () => {
  it("repairs legacy JSON control escapes before rendering mathematics", () => {
    const corrupted = "$x=" + "\f" + "rac{1}{2}, y=" + "\t" + "au$";
    expect(normalizeTex(corrupted)).toBe(String.raw`$x=\frac{1}{2}, y=\tau$`);
  });

  it("repairs observed pre-guard sentinels and exposes unknown controls", () => {
    const legacy = "$" + "\x07" + "alpha+" + "\x0b" + "Sigma$; genus-" + "\x02" + "2";
    expect(normalizeTex(legacy)).toBe(String.raw`$\alpha+\Sigma$; genus-2`);
    expect(normalizeTex("unknown " + "\x03" + " byte")).toBe("unknown � byte");
  });

  it("rewrites \\( … \\) to $ … $", () => {
    expect(idempotent("Let \\(N\\ge 0\\) be an integer.")).toBe("Let $N\\ge 0$ be an integer.");
  });

  it("rewrites several runs on one line", () => {
    expect(idempotent("integers \\(N\\ge 0\\) and \\(0\\le r\\le N\\)")).toBe(
      "integers $N\\ge 0$ and $0\\le r\\le N$",
    );
  });

  it("keeps the inner TeX byte-for-byte", () => {
    expect(idempotent("\\(\\mathbf P^N_{\\mathbf C}\\)")).toBe("$\\mathbf P^N_{\\mathbf C}$");
  });

  it("handles an empty run", () => {
    expect(idempotent("a \\(\\) b")).toBe("a $$ b");
  });
});

describe("normalizeTex — display math", () => {
  it("rewrites \\[ … \\] to $$ … $$", () => {
    expect(idempotent("\\[ X=V(f_1,\\ldots,f_r) \\]")).toBe("$$ X=V(f_1,\\ldots,f_r) $$");
  });

  it("rewrites a multi-line display block in place", () => {
    const src = "before\n\\[\n  X = V(f_1,\\ldots,f_r)\n\\]\nafter";
    expect(idempotent(src)).toBe("before\n$$\n  X = V(f_1,\\ldots,f_r)\n$$\nafter");
  });

  it("keeps \\\\ line breaks inside display math", () => {
    expect(idempotent("\\[ a \\\\ b \\]")).toBe("$$ a \\\\ b $$");
  });

  it("repairs scalable delimiters that cross rows in an aligned environment", () => {
    const src = String.raw`$$
\begin{aligned}
&\left\langle \tau_0(H^2)^{a_{20}},\tau_0(H^3)^{a_{30}},
\tau_1(H)^{a_{11}},\tau_1(H^2)^{a_{21}},\tau_1(H^3)^{a_{31}}, \\
&\hspace{45mm} \tau_0(\alpha_1)\cdots\tau_0(\alpha_p)
\tau_1(\beta_1)\cdots\tau_1(\beta_q) \right\rangle_{2,d},
\end{aligned} \tag{4.1}
$$`;
    const normalized = idempotent(src);

    expect(normalized).toContain(String.raw`\Bigl\langle`);
    expect(normalized).toContain(String.raw`\Bigr\rangle_{2,d}`);
    expect(normalized).not.toContain(String.raw`\left\langle`);
    expect(() =>
      katex.renderToString(normalized.slice(2, -2), {
        displayMode: true,
        strict: false,
        throwOnError: true,
      }),
    ).not.toThrow();
  });

  it("preserves valid scalable delimiters surrounding a multiline environment", () => {
    const src = String.raw`$$\left\{\begin{aligned}a&=b\\c&=d\end{aligned}\right.$$`;
    expect(idempotent(src)).toBe(src);
    expect(() =>
      katex.renderToString(src.slice(2, -2), {
        displayMode: true,
        strict: false,
        throwOnError: true,
      }),
    ).not.toThrow();
  });
});

describe("normalizeTex — mixed documents", () => {
  it("handles the live-run example", () => {
    const src =
      "Let integers \\(N\\ge 0\\) and \\(0\\le r\\le N\\) be given. Then\n" +
      "\\[ X=V(f_1,\\ldots,f_r)\\subset \\mathbf P^N_{\\mathbf C} \\]\n" +
      "is a variety.";
    expect(idempotent(src)).toBe(
      "Let integers $N\\ge 0$ and $0\\le r\\le N$ be given. Then\n" +
        "$$ X=V(f_1,\\ldots,f_r)\\subset \\mathbf P^N_{\\mathbf C} $$\n" +
        "is a variety.",
    );
  });

  it("mixes converted and pre-existing dollar math", () => {
    expect(idempotent("$a+b$ and \\(c+d\\) and $$e$$")).toBe("$a+b$ and $c+d$ and $$e$$");
  });

  it("leaves a document with no LaTeX delimiters exactly alone", () => {
    const src = "# Title\n\nplain $x$ text with 100% \\alpha and a `code` span.\n";
    expect(normalizeTex(src)).toBe(src);
  });
});

describe("normalizeTex — existing dollar math is never double-converted", () => {
  it("does not touch \\( inside an existing $ … $ run", () => {
    expect(idempotent("$\\text{\\(x\\)}$ tail")).toBe("$\\text{\\(x\\)}$ tail");
  });

  it("does not touch \\[ inside an existing $$ … $$ run", () => {
    expect(idempotent("$$ \\[x\\] $$")).toBe("$$ \\[x\\] $$");
  });

  it("survives an unmatched dollar sign in prose", () => {
    expect(idempotent("it costs $5 and \\(x\\) too")).toBe("it costs $5 and $x$ too");
  });
});

describe("normalizeTex — code is verbatim", () => {
  it("skips fenced code blocks", () => {
    const src = "text \\(a\\)\n```\n\\(not math\\)\n\\[nor this\\]\n```\nafter \\(b\\)";
    expect(idempotent(src)).toBe("text $a$\n```\n\\(not math\\)\n\\[nor this\\]\n```\nafter $b$");
  });

  it("skips tilde fences and fences with an info string", () => {
    const src = "~~~tex\n\\(x\\)\n~~~\n```latex\n\\[y\\]\n```";
    expect(idempotent(src)).toBe(src);
  });

  it("treats an unclosed fence as running to the end of the document", () => {
    const src = "intro \\(a\\)\n```\n\\(b\\)\nstill code \\[c\\]";
    expect(idempotent(src)).toBe("intro $a$\n```\n\\(b\\)\nstill code \\[c\\]");
  });

  it("skips inline code spans", () => {
    expect(idempotent("use `\\(x\\)` but render \\(y\\)")).toBe("use `\\(x\\)` but render $y$");
  });

  it("skips multi-backtick code spans", () => {
    expect(idempotent("``a ` \\(b\\)`` then \\(c\\)")).toBe("``a ` \\(b\\)`` then $c$");
  });

  it("keeps a lone backtick literal without swallowing later math", () => {
    expect(idempotent("a ` lone tick\n\nlater \\(x\\)")).toBe("a ` lone tick\n\nlater $x$");
  });
});

describe("normalizeTex — escapes", () => {
  it("does not treat \\\\( as a delimiter", () => {
    expect(idempotent("a \\\\(b) c")).toBe("a \\\\(b) c");
  });

  it("does not treat \\\\[ as a delimiter", () => {
    expect(idempotent("a \\\\[b] c")).toBe("a \\\\[b] c");
  });

  it("still converts a real delimiter after an escaped backslash", () => {
    expect(idempotent("\\\\ \\(x\\)")).toBe("\\\\ $x$");
  });

  it("does not treat \\\\) as a closer", () => {
    // `\\` is a TeX line break, so the run closes at the later `\)`.
    expect(idempotent("\\(a \\\\) b\\)")).toBe("$a \\\\) b$");
  });
});

describe("normalizeTex — unbalanced input is left alone", () => {
  it("leaves an unterminated \\( as-is", () => {
    expect(idempotent("dangling \\(x + y and more text")).toBe("dangling \\(x + y and more text");
  });

  it("leaves an unterminated \\[ as-is", () => {
    expect(idempotent("dangling \\[x + y")).toBe("dangling \\[x + y");
  });

  it("stops the search at a paragraph break", () => {
    const src = "open \\(x\n\nnew paragraph \\(y\\) here";
    expect(idempotent(src)).toBe("open \\(x\n\nnew paragraph $y$ here");
  });

  it("leaves a stray closer alone", () => {
    expect(idempotent("stray \\) and \\] alone")).toBe("stray \\) and \\] alone");
  });

  it("converts only the delimiters it can pair", () => {
    expect(idempotent("\\(a\\) then \\[b")).toBe("$a$ then \\[b");
  });

  it("handles a trailing lone backslash", () => {
    expect(idempotent("tail \\(x\\) \\")).toBe("tail $x$ \\");
  });

  it("handles the empty string", () => {
    expect(normalizeTex("")).toBe("");
  });
});

describe("normalizeTex — idempotence over repeated application", () => {
  const cases = [
    "Let \\(N\\ge 0\\) and \\[X=V(f)\\] hold.",
    "$a$ \\(b\\) $$c$$ \\[d\\]",
    "```\n\\(x\\)\n```\n\\(y\\)",
    "unbalanced \\( and $ and ` all at once",
    "\\(\\)\\[\\]",
  ];
  for (const src of cases) {
    it(`is stable for ${JSON.stringify(src.slice(0, 32))}`, () => {
      const once = normalizeTex(src);
      expect(normalizeTex(once)).toBe(once);
      expect(normalizeTex(normalizeTex(once))).toBe(once);
    });
  }
});

describe("splitMath / stripMath", () => {
  it("splits a label into text and math runs", () => {
    expect(splitMath("Let \\(N\\ge 0\\) be given")).toEqual([
      { math: false, text: "Let " },
      { math: true, text: "N\\ge 0" },
      { math: false, text: " be given" },
    ]);
  });

  it("accepts dollar delimiters directly", () => {
    expect(splitMath("$x^2$ dominates")).toEqual([
      { math: true, text: "x^2" },
      { math: false, text: " dominates" },
    ]);
  });

  it("returns display runs as a single math segment", () => {
    expect(splitMath("\\[x\\]")).toEqual([{ math: true, text: "x" }]);
  });

  it("returns one text segment when there is no math", () => {
    expect(splitMath("no math here")).toEqual([{ math: false, text: "no math here" }]);
  });

  it("keeps an unterminated delimiter as text", () => {
    expect(splitMath("open $x and on")).toEqual([{ math: false, text: "open $x and on" }]);
  });

  it("returns nothing for the empty string", () => {
    expect(splitMath("")).toEqual([]);
  });

  it("strips delimiters for the math-off view", () => {
    expect(stripMath("Let \\(N\\ge 0\\) and $r\\le N$")).toBe("Let N\\ge 0 and r\\le N");
  });
});
