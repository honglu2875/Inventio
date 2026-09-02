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
      // Mirror the raw transport rule: standard JSON newline semantics take
      // precedence over ambiguous single-slash `\ne` and `\nu` spellings.
      if (text[i] === "\n" && (command === "ne" || command === "nu")) {
        out += text[i]!;
        i += 1;
        continue;
      }
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
  let repaired = repairSilentJsonTexControls(text)
    // A former raw-JSON guard could mistake a genuine `\n` line break before
    // a line beginning with `e` for the TeX relation `\ne`. At the start of a
    // display, that relation has no left operand. Keep persisted legacy facts
    // readable without rewriting their event history.
    .replace(/(\\\[|\$\$)[ \t]*\\ne/g, "$1\ne")
    // Conventional negative spacing after an Euler class is not a sensible
    // use of the binary not-equal relation. Restore the swallowed line break.
    .replace(/\\ne(?=\\!\\left)/g, "\ne")
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

  // A short-lived legacy guard also converted a genuine JSON newline before
  // an ordinary Toda field `u` into the perfectly valid TeX command `\nu`.
  // Unlike the control-byte cases above, `\nu` may be intentional mathematics,
  // so repair only equations whose right-hand side identifies the established
  // Toda `u` field unambiguously. Once such a damaged definition is present,
  // its matching derivatives in the same document are safe to restore too.
  const damagedTodaField =
    /\\nu\s*=\s*\(\\Lambda-1\)(?:G|\\mathcal F)_t/.test(repaired) ||
    /\\nu\s*=\s*D\\Psi_\{0,T\}/.test(repaired) ||
    /\\nu_T\s*=\s*Dv\b/.test(repaired);
  if (damagedTodaField) {
    repaired = repaired
      .replace(/\\nu(?=\s*=\s*\(\\Lambda-1\)(?:G|\\mathcal F)_t)/g, "u")
      .replace(/\\nu(?=\s*=\s*D\\Psi_\{0,T\})/g, "u")
      .replace(/\\nu_T(?=\s*=\s*Dv\b)/g, "u_T")
      .replace(/\\nu_t(?=\s*=\s*v\^\+-v)/g, "u_t")
      .replace(/D\\nu\b/g, "Du")
      .replace(/z\+\\nu\+vz\^\{-1\}/g, "z+u+vz^{-1}");
  }
  const damagedTodaCoefficients =
    /U\s*=\s*\\sum[^\n]*u_n/.test(repaired) && /\\nu_n\s*=\s*d_n/.test(repaired);
  if (damagedTodaCoefficients) {
    repaired = repaired
      .replace(/\\nu_n(?=\s*=\s*d_n\b)/g, "u_n")
      .replace(/\\nu_S(?=\s*=\s*D\[z\^\{-1\}\])/g, "u_S");
  }

  return repaired;
}
