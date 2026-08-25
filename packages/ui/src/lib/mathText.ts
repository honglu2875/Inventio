import { repairLegacyArtifactControls } from "@inventio/schema";

/**
 * TeX delimiter normalization (UI-SPEC §1).
 *
 * `remark-math` only knows `$…$` / `$$…$$`, but the models emit LaTeX's own
 * delimiters — `\( … \)` and `\[ … \]` — all the time. Every markdown surface
 * runs its source through `normalizeTex` first, and `<MathText>` reuses the
 * same scanner to split short labels into text and math runs.
 *
 * The scanner is deliberately conservative: it never rewrites anything it is
 * not certain about, because a corrupted document is far worse than an
 * unrendered formula. In particular:
 *
 * - Fenced code blocks (``` / ~~~) and inline code spans are copied verbatim.
 * - `\\(` is an escaped backslash followed by a paren, not a delimiter.
 * - Existing `$…$` / `$$…$$` delimiters are never converted twice. Their TeX
 *   is preserved except for one surgical compatibility repair: a `\left` /
 *   `\right` pair cannot cross a row or cell boundary inside an alignment
 *   environment, so that invalid model-output pattern is changed to fixed-size
 *   `\Bigl` / `\Bigr` delimiters.
 * - An opener with no matching closer *in the same paragraph* is left exactly
 *   as it was; a blank line always ends the search, so one stray `\(` can
 *   never swallow the rest of a document.
 */

// --------------------------------------------------------------- scan helpers

/** True when the newline at `i` is followed by a blank (whitespace-only) line. */
function isParagraphBreak(src: string, i: number): boolean {
  let j = i + 1;
  while (j < src.length && (src[j] === " " || src[j] === "\t" || src[j] === "\r")) j += 1;
  return j >= src.length || src[j] === "\n";
}

/** Length of the backtick run starting at `i`. */
function backtickRun(src: string, i: number): number {
  let n = 0;
  while (src[i + n] === "`") n += 1;
  return n;
}

/** Length of the dollar run starting at `i`. */
function dollarRun(src: string, i: number): number {
  let n = 0;
  while (src[i + n] === "$") n += 1;
  return n;
}

/** Index of the closing backtick run of exactly `len`, or -1. */
function findCodeClose(src: string, from: number, len: number): number {
  let i = from;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "`") {
      const run = backtickRun(src, i);
      if (run === len) return i;
      i += run;
      continue;
    }
    // A code span cannot cross a paragraph break: a lone backtick stays literal.
    if (ch === "\n" && isParagraphBreak(src, i)) return -1;
    i += 1;
  }
  return -1;
}

/** Index of the `$`/`$$` that closes a math run opened with `delim`, or -1. */
function findDollarClose(src: string, from: number, delim: "$" | "$$"): number {
  let i = from;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2; // `\$`, `\\`, `\alpha` — never a delimiter
      continue;
    }
    if (ch === "$") {
      const run = dollarRun(src, i);
      if (delim === "$") return i;
      if (run >= 2) return i;
      i += run;
      continue;
    }
    if (ch === "\n" && isParagraphBreak(src, i)) return -1;
    i += 1;
  }
  return -1;
}

/** Index of the `\)` / `\]` closing a run opened at `from - 2`, or -1. */
function findTexClose(src: string, from: number, closer: ")" | "]"): number {
  let i = from;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      if (src[i + 1] === closer) return i;
      i += 2; // `\\` (a TeX line break) and every other escape skip as a pair
      continue;
    }
    if (ch === "\n" && isParagraphBreak(src, i)) return -1;
    i += 1;
  }
  return -1;
}

// ----------------------------------------------------- alignment compatibility

/**
 * Environments whose `&` and `\\` tokens create TeX alignment groups. A
 * scalable `\left` delimiter opened in one such group cannot be closed by a
 * `\right` in another, even when the visual intention is obvious.
 */
const ALIGNMENT_ENVIRONMENTS = new Set([
  "align",
  "align*",
  "aligned",
  "alignedat",
  "array",
  "Bmatrix",
  "bmatrix",
  "cases",
  "gather",
  "gather*",
  "gathered",
  "matrix",
  "multline",
  "multline*",
  "pmatrix",
  "smallmatrix",
  "split",
  "Vmatrix",
  "vmatrix",
]);

interface AlignmentDelimiter {
  pos: number;
  row: number;
  cell: number;
  delimiter: string | null;
}

interface EnvironmentFrame {
  name: string;
  alignment:
    | {
        braceDepth: number;
        row: number;
        cell: number;
        openDelimiters: AlignmentDelimiter[];
      }
    | null;
}

function environmentToken(
  src: string,
  at: number,
  kind: "begin" | "end",
): { name: string; length: number } | null {
  const prefix = `\\${kind}{`;
  if (!src.startsWith(prefix, at)) return null;
  const close = src.indexOf("}", at + prefix.length);
  if (close === -1) return null;
  const name = src.slice(at + prefix.length, close);
  if (!/^[A-Za-z*]+$/.test(name)) return null;
  return { name, length: close + 1 - at };
}

function controlWordAt(src: string, at: number, word: string): boolean {
  if (!src.startsWith(`\\${word}`, at)) return false;
  const next = src[at + word.length + 1];
  return next === undefined || !/[A-Za-z]/.test(next);
}

/** Delimiter token immediately following `\left` or `\right`. */
function followingDelimiter(src: string, at: number): string | null {
  let i = at;
  while (src[i] === " " || src[i] === "\t" || src[i] === "\r" || src[i] === "\n") i += 1;
  if (i >= src.length) return null;
  if (src[i] !== "\\") return src[i] ?? null;
  let j = i + 1;
  if (/[A-Za-z]/.test(src[j] ?? "")) {
    while (/[A-Za-z]/.test(src[j] ?? "")) j += 1;
  } else {
    j += 1;
  }
  return src.slice(i, j);
}

/**
 * Repair only provably invalid scalable delimiters inside math source.
 *
 * We track the current row and cell of each alignment environment. If a
 * matching `\left` / `\right` pair lands in different groups, replace the two
 * sizing commands with `\Bigl` / `\Bigr`. Fixed-size delimiters may live in
 * separate rows and preserve the intended glyphs. Delimiters surrounding an
 * entire nested `aligned` environment remain untouched because they are valid.
 */
function repairCrossAlignmentDelimiters(tex: string): string {
  if (
    !tex.includes("\\begin{") ||
    !tex.includes("\\left") ||
    !tex.includes("\\right")
  ) {
    return tex;
  }

  const environments: EnvironmentFrame[] = [];
  const replacements = new Map<number, { length: number; text: string }>();
  let braceDepth = 0;
  let i = 0;

  while (i < tex.length) {
    // A TeX comment runs to the physical newline. Its contents are inert.
    if (tex[i] === "%") {
      const newline = tex.indexOf("\n", i + 1);
      if (newline === -1) break;
      i = newline + 1;
      continue;
    }

    const begin = environmentToken(tex, i, "begin");
    if (begin !== null) {
      environments.push({
        name: begin.name,
        alignment: ALIGNMENT_ENVIRONMENTS.has(begin.name)
          ? { braceDepth, row: 0, cell: 0, openDelimiters: [] }
          : null,
      });
      i += begin.length;
      continue;
    }

    const end = environmentToken(tex, i, "end");
    if (end !== null) {
      if (environments.at(-1)?.name === end.name) environments.pop();
      i += end.length;
      continue;
    }

    const frame = environments.at(-1)?.alignment ?? null;
    const atAlignmentLevel = frame !== null && braceDepth === frame.braceDepth;

    if (controlWordAt(tex, i, "left")) {
      if (atAlignmentLevel) {
        frame.openDelimiters.push({
          pos: i,
          row: frame.row,
          cell: frame.cell,
          delimiter: followingDelimiter(tex, i + "\\left".length),
        });
      }
      i += "\\left".length;
      continue;
    }

    if (controlWordAt(tex, i, "right")) {
      if (atAlignmentLevel) {
        const open = frame.openDelimiters.pop();
        const closeDelimiter = followingDelimiter(tex, i + "\\right".length);
        if (
          open !== undefined &&
          open.delimiter !== "." &&
          closeDelimiter !== "." &&
          (open.row !== frame.row || open.cell !== frame.cell)
        ) {
          replacements.set(open.pos, { length: "\\left".length, text: "\\Bigl" });
          replacements.set(i, { length: "\\right".length, text: "\\Bigr" });
        }
      }
      i += "\\right".length;
      continue;
    }

    if (atAlignmentLevel && tex.startsWith("\\\\", i)) {
      frame.row += 1;
      frame.cell = 0;
      i += 2;
      continue;
    }

    if (atAlignmentLevel && controlWordAt(tex, i, "cr")) {
      frame.row += 1;
      frame.cell = 0;
      i += "\\cr".length;
      continue;
    }

    if (atAlignmentLevel && tex[i] === "&") {
      frame.cell += 1;
      i += 1;
      continue;
    }

    if (tex[i] === "{") {
      braceDepth += 1;
      i += 1;
      continue;
    }
    if (tex[i] === "}") {
      braceDepth = Math.max(0, braceDepth - 1);
      i += 1;
      continue;
    }

    // Skip every other TeX command as one token, so escaped braces, ampersands,
    // and percent signs cannot be mistaken for alignment syntax.
    if (tex[i] === "\\") {
      let j = i + 1;
      if (/[A-Za-z]/.test(tex[j] ?? "")) {
        while (/[A-Za-z]/.test(tex[j] ?? "")) j += 1;
      } else {
        j += 1;
      }
      i = j;
      continue;
    }

    i += 1;
  }

  if (replacements.size === 0) return tex;
  let repaired = tex;
  for (const [pos, replacement] of [...replacements].sort((a, b) => b[0] - a[0])) {
    repaired =
      repaired.slice(0, pos) +
      replacement.text +
      repaired.slice(pos + replacement.length);
  }
  return repaired;
}

// ------------------------------------------------------------ chunk conversion

/**
 * Convert one fence-free chunk. Code spans are copied through untouched.
 * Existing dollar runs keep their delimiters and receive only the narrow
 * alignment repair above; a `\(…\)` / `\[…\]` pair that closes inside the same
 * paragraph is rewritten to dollar delimiters.
 */
function convertChunk(chunk: string): string {
  let out = "";
  let i = 0;
  while (i < chunk.length) {
    const ch = chunk[i];

    if (ch === "`") {
      const run = backtickRun(chunk, i);
      const close = findCodeClose(chunk, i + run, run);
      if (close === -1) {
        out += chunk.slice(i, i + run);
        i += run;
      } else {
        out += chunk.slice(i, close + run);
        i = close + run;
      }
      continue;
    }

    if (ch === "$") {
      const run = dollarRun(chunk, i);
      const delim = run >= 2 ? "$$" : "$";
      const close = findDollarClose(chunk, i + delim.length, delim);
      if (close === -1) {
        out += delim;
        i += delim.length;
      } else {
        const closeLen = delim.length;
        const inner = chunk.slice(i + delim.length, close);
        out += delim + repairCrossAlignmentDelimiters(inner) + delim;
        i = close + closeLen;
      }
      continue;
    }

    if (ch === "\\") {
      const next = chunk[i + 1];
      if (next === "(" || next === "[") {
        const closer = next === "(" ? ")" : "]";
        const close = findTexClose(chunk, i + 2, closer);
        if (close !== -1) {
          const wrap = next === "(" ? "$" : "$$";
          out += wrap + repairCrossAlignmentDelimiters(chunk.slice(i + 2, close)) + wrap;
          i = close + 2;
          continue;
        }
      }
      // Escaped char (including `\\`), or an unterminated delimiter: verbatim.
      out += next === undefined ? "\\" : chunk.slice(i, i + 2);
      i += 2;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

// ------------------------------------------------------------- fenced regions

interface Fence {
  char: string;
  len: number;
}

/** The fence a line opens, or null. Backtick fences may not carry backticks. */
function fenceOpenedBy(line: string): Fence | null {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!match) return null;
  const run = match[1] as string;
  const char = run[0] as string;
  if (char === "`" && line.slice(match[0].length).includes("`")) return null;
  return { char, len: run.length };
}

function fenceClosedBy(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  if (!match) return false;
  const run = match[1] as string;
  return run[0] === fence.char && run.length >= fence.len;
}

/**
 * Rewrite `\(…\)` → `$…$` and `\[…\]` → `$$…$$` outside code.
 * Idempotent: `normalizeTex(normalizeTex(x)) === normalizeTex(x)`.
 */
export function normalizeTex(src: string): string {
  const repaired = repairLegacyArtifactControls(src);
  const mayNeedAlignmentRepair =
    repaired.includes("\\begin{") &&
    repaired.includes("\\left") &&
    repaired.includes("\\right");
  if (
    repaired === "" ||
    (!repaired.includes("\\(") && !repaired.includes("\\[") && !mayNeedAlignmentRepair)
  ) {
    return repaired;
  }

  const lines = repaired.split("\n");
  const out: string[] = [];
  let pending: string[] = [];
  let fence: Fence | null = null;

  const flush = (): void => {
    if (pending.length === 0) return;
    out.push(convertChunk(pending.join("\n")));
    pending = [];
  };

  for (const line of lines) {
    if (fence !== null) {
      out.push(line);
      if (fenceClosedBy(line, fence)) fence = null;
      continue;
    }
    const opened = fenceOpenedBy(line);
    if (opened !== null) {
      flush();
      out.push(line);
      fence = opened;
      continue;
    }
    pending.push(line);
  }
  flush();
  return out.join("\n");
}

// ---------------------------------------------------------------- short labels

export interface MathSegment {
  /** true → `text` is TeX source (delimiters already removed). */
  math: boolean;
  text: string;
}

/**
 * Split a short single-line string into alternating text and math runs, after
 * normalizing delimiters. `$$…$$` in a label is still returned as one math run
 * (callers render labels inline, never in display mode).
 */
export function splitMath(src: string): MathSegment[] {
  const source = normalizeTex(src);
  const segments: MathSegment[] = [];
  let plain = "";
  let i = 0;

  const pushPlain = (): void => {
    if (plain !== "") {
      segments.push({ math: false, text: plain });
      plain = "";
    }
  };

  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      plain += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "$") {
      const run = dollarRun(source, i);
      const delim = run >= 2 ? "$$" : "$";
      const close = findDollarClose(source, i + delim.length, delim);
      if (close !== -1) {
        const inner = source.slice(i + delim.length, close);
        pushPlain();
        segments.push({ math: true, text: inner });
        i = close + delim.length;
        continue;
      }
      plain += delim;
      i += delim.length;
      continue;
    }
    plain += ch;
    i += 1;
  }
  pushPlain();
  return segments;
}

/** The same string with math delimiters removed — the "render math off" view. */
export function stripMath(src: string): string {
  return splitMath(src)
    .map((segment) => segment.text)
    .join("");
}
