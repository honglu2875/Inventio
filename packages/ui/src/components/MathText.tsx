import { Fragment, useMemo } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import { splitMath, stripMath } from "../lib/mathText";
import { useStore } from "../store/store";

/**
 * Rendered math in the places that are not markdown (UI-SPEC §5, §8, §10):
 * graph node labels, memory cards, claim statements, inspector lists.
 *
 * The string is split on `$…$` (after `normalizeTex`) and the math runs are
 * rendered by KaTeX. The injected HTML is KaTeX's own output for a TeX source
 * — never user HTML — and `throwOnError: false` means malformed TeX renders as
 * a red error node instead of throwing; anything unexpected still falls back to
 * the raw text. Rendering is memoized by input string: the same claim statement
 * re-renders on every store update, and KaTeX is not cheap.
 */

interface Rendered {
  /** KaTeX HTML, or null when the run is plain text. */
  html: string | null;
  text: string;
}

const CACHE_LIMIT = 500;
const cache = new Map<string, Rendered[]>();

function render(src: string): Rendered[] {
  const hit = cache.get(src);
  if (hit !== undefined) return hit;

  const out = splitMath(src).map((segment): Rendered => {
    if (!segment.math) return { html: null, text: segment.text };
    try {
      // Labels are single-line: display runs render inline too (§5).
      const html = katex.renderToString(segment.text, {
        throwOnError: false,
        strict: false,
        displayMode: false,
      });
      return { html, text: segment.text };
    } catch {
      return { html: null, text: segment.text };
    }
  });

  // A crude cap: the working set is node labels and table rows, so clearing
  // wholesale is cheaper than tracking LRU order.
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(src, out);
  return out;
}

export default function MathText({
  children,
  className,
}: {
  children: string | null | undefined;
  className?: string;
}): JSX.Element {
  const renderMath = useStore((s) => s.renderMath);
  const source = children ?? "";
  const segments = useMemo(
    () => (renderMath ? render(source) : null),
    [renderMath, source],
  );
  const cls = className === undefined ? "mathtext" : `mathtext ${className}`;

  if (segments === null) {
    // Math off: the same text with the delimiters removed — raw TeX with `$`
    // signs sprinkled through it is strictly harder to read.
    return <span className={cls}>{stripMath(source)}</span>;
  }

  return (
    <span className={cls}>
      {segments.map((segment, i) =>
        segment.html === null ? (
          <Fragment key={i}>{segment.text}</Fragment>
        ) : (
          <span key={i} dangerouslySetInnerHTML={{ __html: segment.html }} />
        ),
      )}
    </span>
  );
}
