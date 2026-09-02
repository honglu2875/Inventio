import { describe, expect, it } from "vitest";
import { repairLegacyArtifactControls } from "../src/tex-integrity.js";

describe("legacy TeX transport repair", () => {
  it("restores a display newline that an older JSON guard rendered as \\ne", () => {
    const damaged = String.raw`\[\ne(T_Q)=c_3(T_Q)`;
    expect(repairLegacyArtifactControls(damaged)).toBe(
      "\\[\ne(T_Q)=c_3(T_Q)",
    );
  });

  it("leaves an actual not-equal command alone", () => {
    expect(repairLegacyArtifactControls(String.raw`\[x\ne0\]`)).toBe(
      String.raw`\[x\ne0\]`,
    );
  });

  it("restores a legacy display line break before a spaced Euler class", () => {
    const damaged = String.raw`\int_{[M]^{vir}}\ne\!\left(-R\pi_*E\right)`;
    expect(repairLegacyArtifactControls(damaged)).toBe(
      "\\int_{[M]^{vir}}\ne\\!\\left(-R\\pi_*E\\right)",
    );
  });

  it("restores an ordinary Toda u that an older guard joined to a newline", () => {
    const damaged = String.raw`Setting
\[\nu=(\Lambda-1)G_t,\qquad L=\Lambda+u+v\Lambda^{-1}\]
gives \[\nu_t=v^+-v\]. Later \(\nu=D\Psi_{0,T}\) and \((D\nu)^2\).`;
    const repaired = repairLegacyArtifactControls(damaged);

    expect(repaired).toContain(String.raw`\[u=(\Lambda-1)G_t`);
    expect(repaired).toContain(String.raw`\[u_t=v^+-v`);
    expect(repaired).toContain(String.raw`\(u=D\Psi_{0,T}\)`);
    expect(repaired).toContain(String.raw`\((Du)^2\)`);
  });

  it("repairs indexed Toda coefficients only when their U-series identifies u_n", () => {
    const damaged = String.raw`\[U=\sum_{n\text{ odd}}u_n\frac{w^n}{n!}\]
\[\nu_n=d_n(-1)^{d_n-1}N_n\]
\[\nu_S=D[z^{-1}]\frac{\ell^k}{k!}\]`;
    const repaired = repairLegacyArtifactControls(damaged);

    expect(repaired).toContain(String.raw`\[u_n=d_n(-1)^{d_n-1}N_n\]`);
    expect(repaired).toContain(String.raw`\[u_S=D[z^{-1}]`);
  });

  it("does not rewrite a genuine Greek nu", () => {
    const genuine = String.raw`\[\nu_n=\sum_{j=1}^n a_j,\qquad D\nu=0\]`;
    expect(repairLegacyArtifactControls(genuine)).toBe(genuine);
  });
});
