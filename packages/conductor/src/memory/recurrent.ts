import { resultMathematics, resultStatus, type ProjectState } from "@inventio/schema";
import { FileMemoryBackend } from "./cardStore.js";
import type { TaskScope, RecallRecord } from "./types.js";

/** One logical filesystem, with a server-enforced mathematical-only projection. */
export class RecurrentMemoryBackend extends FileMemoryBackend {
  constructor(projectDir: string, onRecall: (rec: RecallRecord) => void,
    private state: () => ProjectState,
    readonly checkpointResearch: (scope: TaskScope, results: unknown[]) => unknown,
    readonly assessResearch: (scope: TaskScope, assessment: unknown) => void,
  ) { super(projectDir, onRecall); }
  supportsRecurrentTools(): boolean { return true; }
  supportsTrajectoryTools(): boolean { return true; }
  private documents(scope: TaskScope): { id: string; title: string; markdown: string }[] {
    const s = this.state().research;
    const blind = scope.role === "auditor" || scope.role === "verifier";
    const allowed = new Set(scope.allowedVersionIds ?? []);
    const results = s.versionOrder.filter(id => !blind || allowed.has(id)).map(id => {
      const v = s.versions[id]!;
      const mathematics = resultMathematics(v);
      return { id, title: v.title, markdown: blind ? mathematics : `Current qualification: ${resultStatus(s, id)}\n\n${mathematics}` };
    });
    if (blind) return results;
    return [...results, ...Object.values(s.notes).map(n => ({ id: n.id, title: n.name, markdown: n.markdown }))];
  }
  searchResearch(scope: TaskScope, query: string, limit: number): { id: string; title: string }[] {
    const needle = query.toLowerCase();
    return this.documents(scope).filter(d => `${d.id}\n${d.title}\n${d.markdown}`.toLowerCase().includes(needle)).slice(0, Math.min(50, Math.max(1, limit))).map(({ id, title }) => ({ id, title }));
  }
  openResearch(scope: TaskScope, id: string, start: number, maxCharacters: number): { id: string; title: string; markdown: string; end: number; totalCharacters: number } | null {
    const doc = this.documents(scope).find(d => d.id === id);
    if (!doc) return null;
    const offset = Math.max(0, Math.floor(start));
    const end = Math.min(doc.markdown.length, offset + Math.min(30_000, Math.max(1, Math.floor(maxCharacters))));
    return { id, title: doc.title, markdown: doc.markdown.slice(offset, end), end, totalCharacters: doc.markdown.length };
  }
}
