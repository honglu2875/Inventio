import {
  isSilentJsonTexCommand,
  repairSilentJsonTexControls,
} from "@inventio/schema";

/** Read the ASCII control word beginning at `start` (which points at b/f/n/r/t). */
function controlWordAt(text: string, start: number): { word: string; end: number } {
  let end = start;
  while (end < text.length && /[A-Za-z]/.test(text[end]!)) end += 1;
  return { word: text.slice(start, end), end };
}

/**
 * Double only those single slashes inside JSON strings that spell a complete
 * known TeX command but would otherwise be accepted as a JSON control escape.
 * Properly escaped `\\frac`, ordinary `\n` line breaks, object syntax, and
 * prose are copied byte-for-byte.
 */
export function protectModelJsonTex(text: string): string {
  let out = "";
  let inString = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;
    if (!inString) {
      out += ch;
      if (ch === '"') inString = true;
      i += 1;
      continue;
    }

    if (ch === '"') {
      out += ch;
      inString = false;
      i += 1;
      continue;
    }

    if (ch !== "\\") {
      out += ch;
      i += 1;
      continue;
    }

    const next = text[i + 1];
    if (next === undefined) {
      out += ch;
      i += 1;
      continue;
    }

    // Preserve every normal JSON escape. Only b/f/n/r/t can be both a legal
    // JSON escape and the first letter of a TeX control word.
    if (next === "b" || next === "f" || next === "n" || next === "r" || next === "t") {
      const { word, end } = controlWordAt(text, i + 1);
      if (isSilentJsonTexCommand(word)) {
        out += `\\\\${word}`;
        i = end;
        continue;
      }
    }

    out += ch + next;
    i += 2;
  }
  return out;
}

function repairDeep(value: unknown): unknown {
  if (typeof value === "string") return repairSilentJsonTexControls(value);
  if (Array.isArray(value)) return value.map(repairDeep);
  if (value !== null && typeof value === "object") {
    const repaired: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      repaired[key] = repairDeep(child);
    }
    return repaired;
  }
  return value;
}

function findForbiddenControls(value: unknown, path = "(root)"): string[] {
  if (typeof value === "string") {
    const found: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      // Newline, carriage return and tab are ordinary textual whitespace.
      // Every other C0/C1 control is forbidden in model-authored content.
      if ((code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) ||
          (code >= 0x7f && code <= 0x9f)) {
        const hex = `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
        found.push(`${path}: contains forbidden control ${hex} at character ${index}`);
        if (found.length === 3) break;
      }
    }
    return found;
  }
  if (Array.isArray(value)) {
    return value.flatMap((child, index) => findForbiddenControls(child, `${path}.${index}`));
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
      findForbiddenControls(child, path === "(root)" ? key : `${path}.${key}`),
    );
  }
  return [];
}

/** Parse a model JSON reply without allowing legal JSON escapes to eat TeX. */
export function parseModelJson(text: string): unknown {
  const parsed: unknown = JSON.parse(protectModelJsonTex(text));
  const repaired = repairDeep(parsed);
  const forbidden = findForbiddenControls(repaired);
  if (forbidden.length > 0) {
    throw new SyntaxError(
      `ambiguous control escape in model JSON (${forbidden.slice(0, 3).join("; ")}); ` +
        "remove unexplained control characters and double every TeX backslash in the JSON reply",
    );
  }
  return repaired;
}
