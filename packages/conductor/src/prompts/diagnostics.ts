/**
 * Prompts used only by scripts/probe-mcp-approval.ts.
 *
 * They never participate in a research project. They live here nonetheless so
 * a repository-wide prompt review finds every deliberate Codex instruction,
 * including the manual real-account diagnostic that tests MCP approval modes.
 */
export const MCP_APPROVAL_PROBE_AGENTS =
  "Call the memory_search tool with query 'probe', then memory_expand on any id it returns, " +
  "then reply with the exact marker string you found.";

export const MCP_APPROVAL_PROBE_LAUNCH = "Follow AGENTS.md. Report the marker string.";
