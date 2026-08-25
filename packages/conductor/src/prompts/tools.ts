import { CardStatus, CardType } from "@inventio/schema";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Model-visible MCP tool catalog.
 *
 * memory/service.ts returns this array from every `tools/list` request. The
 * descriptions therefore become part of the Research Manager or worker tool
 * context whenever engine/engine.ts attaches the project memory server. The
 * service still enforces authorization and visibility in code; changing these
 * words cannot grant access. `source_list` and `source_open` are advertised to
 * all attached clients but reject every role except `research_manager`.
 */
export const MODEL_TOOL_DEFINITIONS: Tool[] = [
  {
    name: "memory_search",
    description:
      "Search the memory-card catalog (id, type, status, title, abstract, provenance, tags). " +
      "Substring and tag matching; returns at most `limit` rows (default 5, max 20). " +
      "By default this searches the active working library plus QUARANTINED warnings; pass " +
      "`statuses` explicitly to search retired archive records. Promising cards rank first. " +
      "QUARANTINED cards appear flagged as warnings and are never usable as fact.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring to match; empty string matches all cards." },
        types: {
          type: "array",
          description: "Restrict to these card types.",
          items: { type: "string", enum: [...CardType.options] },
        },
        statuses: {
          type: "array",
          description: "Restrict to these statuses; use REFUTED/SUPERSEDED to search the archive.",
          items: { type: "string", enum: [...CardStatus.options] },
        },
        tags: {
          type: "array",
          description: "Restrict to cards carrying at least one of these tags.",
          items: { type: "string" },
        },
        limit: { type: "number", description: "Maximum rows to return (default 5, max 20)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "memory_expand",
    description:
      "Expand memory cards by id: full card content plus the artifact excerpt each card cites. " +
      "A reason is required and every expansion is logged. Expansion of QUARANTINED cards is " +
      "always refused; reviewers may expand only VERIFIED cards.",
    inputSchema: {
      type: "object",
      properties: {
        cardIds: { type: "array", description: "Card ids to expand, e.g. [\"M001\"].", items: { type: "string" } },
        reason: { type: "string", description: "Why this material is needed now (required, non-empty)." },
      },
      required: ["cardIds", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "source_list",
    description:
      "List the owner's retained intake materials by stable source ID, title, abstract, and short excerpt. " +
      "This catalog is available to the Research Manager; use source_open to inspect original text on demand.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional substring filter; empty string lists all sources." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "source_open",
    description:
      "Open a bounded character range from one original intake source. A reason is required. " +
      "Use start/maxCharacters to continue through a long document without loading it all at once.",
    inputSchema: {
      type: "object",
      properties: {
        sourceId: { type: "string", description: "Stable source ID, for example S003." },
        start: { type: "number", description: "Zero-based character offset (default 0)." },
        maxCharacters: { type: "number", description: "Characters to return (default 24000, maximum 80000)." },
        reason: { type: "string", description: "Why the original material is needed now." },
      },
      required: ["sourceId", "reason"],
      additionalProperties: false,
    },
  },
];
