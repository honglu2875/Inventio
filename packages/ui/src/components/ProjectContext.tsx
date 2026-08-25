import { createContext, useContext } from "react";

/**
 * The slug of the project a canvas belongs to. Node components read it from
 * context instead of from node `data`, keeping `data` free of function
 * identities (UI-SPEC §13).
 */
export const ProjectSlugContext = createContext<string>("");

export function useProjectSlug(): string {
  return useContext(ProjectSlugContext);
}
