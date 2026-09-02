import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import Markdown from "../src/components/Markdown";

describe("Markdown mathematics", () => {
  it("renders attached multiline display markers from a stopping report", () => {
    const source = String.raw`Before.

$$\left\langle \tau_0(\alpha)\tau_0(\beta)\tau_0(H)^m\tau_1(1)^s\right\rangle_{g,2+m+s,1}
=-24b_g(2g+m)_s\eta(\alpha,\beta).$$

After.`;
    const html = renderToStaticMarkup(<Markdown>{source}</Markdown>);

    expect(html).toContain("katex-display");
    expect(html).toContain("Before.");
    expect(html).toContain("After.");
    expect(html).not.toContain("$$");
  });
});
