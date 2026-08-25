import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { normalizeTex } from "../lib/mathText";

/**
 * The single markdown renderer (UI-SPEC §1, §7). `$…$` / `$$…$$` via
 * remark-math + rehype-katex. Raw HTML stays disabled — no rehype-raw — and
 * ids like K001/T001 are plain text (no autolinking in v1).
 *
 * Workers emit LaTeX's own `\(…\)` / `\[…\]` delimiters, which remark-math does
 * not recognize, so every source runs through `normalizeTex` first.
 */

const REMARK = [remarkMath];
const REHYPE = [[rehypeKatex, { throwOnError: false, strict: false }]] as never;

export default function Markdown({ children }: { children: string }): JSX.Element {
  const source = useMemo(() => normalizeTex(children), [children]);
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
