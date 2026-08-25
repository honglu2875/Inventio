/**
 * TeX commands whose leading backslash can be silently consumed by
 * JSON.parse. JSON defines \b, \f, \n, \r and \t as control escapes, so a
 * model-authored `\frac`, `\tau`, or `\rho` is valid JSON with the wrong
 * meaning unless the model doubled the slash.
 *
 * Keep this list intentionally specific. A real JSON newline followed by an
 * English word must remain a newline; we repair only complete, familiar TeX
 * control words.
 */
const SILENT_JSON_TEX_COMMANDS = new Set([
  // \b...
  "backslash", "bar", "because", "begin", "beta", "big", "bigl", "bigr",
  "binom", "bmod", "boldsymbol", "bot", "boxed", "breve", "bullet",
  // \f...
  "fbox", "flat", "forall", "frac",
  // \n...
  "nabla", "natural", "ne", "neg", "neq", "nexists", "nmid", "nolimits",
  "nonumber", "normal", "not", "notin", "nparallel", "nu",
  // \r...
  "raisebox", "rangle", "ref", "renewcommand", "rho", "right",
  "rightarrow", "rm", "root", "rule",
  // \t...
  "tag", "tan", "tanh", "tau", "text", "textbf", "textit", "textrm",
  "therefore", "theta", "tfrac", "tilde", "times", "to", "top",
  "triangle", "triangledown", "triangleleft", "triangleright",
]);

const CONTROL_PREFIX: Readonly<Record<string, string>> = {
  "\b": "b",
  "\f": "f",
  "\n": "n",
  "\r": "r",
  "\t": "t",
};

function asciiLettersAt(text: string, start: number): { letters: string; end: number } {
  let end = start;
  while (end < text.length && /[A-Za-z]/.test(text[end]!)) end += 1;
  return { letters: text.slice(start, end), end };
}

/** Used by the raw JSON transport guard before JSON.parse runs. */
export function isSilentJsonTexCommand(command: string): boolean {
  return SILENT_JSON_TEX_COMMANDS.has(command);
}

/**
 * Repair already-parsed legacy text. This makes old artifacts readable while
 * the raw transport guard prevents new corruption before persistence.
 */
export function repairSilentJsonTexControls(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const prefix = CONTROL_PREFIX[text[i]!];
    if (prefix !== undefined) {
      const { letters, end } = asciiLettersAt(text, i + 1);
      const command = prefix + letters;
      if (isSilentJsonTexCommand(command)) {
        out += `\\${command}`;
        i = end;
        continue;
      }
    }
    out += text[i]!;
    i += 1;
  }
  return out;
}

/**
 * Best-effort display repair for a handful of control-byte shapes found in
 * artifacts written before the model-JSON integrity guard existed. These are
 * deliberately not accepted by the transport parser: a new model reply with
 * one of these bytes must be retried instead of guessed at.
 */
export function repairLegacyArtifactControls(text: string): string {
  return repairSilentJsonTexControls(text)
    // Observed legacy spellings of \alpha and \beta.
    .replace(/\x07(?=(?:alpha|beta)\b)/g, "\\")
    // Observed legacy spellings in A016: [\Sigma] and [\overline M].
    .replace(/\x0b(?=Sigma\b)/g, "\\")
    .replace(/\x0b(?=\\overline\b)/g, "")
    // Stray legacy sentinels immediately before an already intact command or
    // a genus digit carry no mathematical content.
    .replace(/\x01(?=\\pm\b)/g, "")
    .replace(/\x02(?=\d)/g, "")
    // Never let an unrecognized control byte render invisibly. Keeping a
    // visible replacement character is safer than silently inventing TeX.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "�");
}
