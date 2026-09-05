import { z } from "zod";
import { Assessment, ResultSubmission, toJsonSchema } from "@inventio/schema";
import { CardStatus, CardType } from "@inventio/schema";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

/**
 * Model-visible MCP tool catalog.
 *
 * memory/service.ts returns this array from every `tools/list` request. The
 * descriptions therefore become part of the Research Manager or worker tool
 * context whenever engine/engine.ts attaches the project memory server. The
 * service still enforces authorization and visibility in code; changing these
 * words cannot grant access. `source_list` and `source_open` are available to
 * the legacy Research Manager and to v2 mathematical trajectories, which need
 * to revisit retained intake sources on demand.
 */
export const MODEL_TOOL_DEFINITIONS: Tool[] = [
  {
    name: "knowledge_search",
    description:
      "Search the trajectories-v2 mathematical library. Returns concise rows for active verified facts " +
      "and claims awaiting verification. Use knowledge_open for the complete statement and proof.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring to match; empty lists the current library." },
        limit: { type: "number", description: "Maximum rows (default 12, maximum 30)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "knowledge_open",
    description:
      "Open complete Markdown for selected fact or active-claim IDs, including the proof. " +
      "Facts passed independent checks; active claims have not yet done so. A SUSPICIOUS fact " +
      "includes its unresolved challenge and is not settled mathematics.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, description: "Fact or claim IDs, e.g. [\"F001\", \"K004\"]." },
        reason: { type: "string", description: "Why the full mathematics is relevant now." },
      },
      required: ["ids", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "writeup_search",
    description:
      "Search concise descriptions of earlier Solver and Explorer write-ups. Use writeup_open only for " +
      "the few full trajectories whose arguments or failures matter to the current investigation.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring to match; empty lists recent write-ups." },
        limit: { type: "number", description: "Maximum rows (default 12, maximum 30)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "writeup_open",
    description: "Open selected earlier mathematical write-ups by artifact ID.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" } },
        maxCharacters: { type: "number", description: "Per-write-up character cap (default 40000, maximum 80000)." },
        reason: { type: "string", description: "Why these full write-ups are relevant now." },
      },
      required: ["ids", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "mark_milestone",
    description:
      "Record one concise mathematical turning point so a human can follow a long trajectory. " +
      "Use sparingly for a new reduction, obstruction, example, or change of approach—not routine progress.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short mathematical title." },
        markdown: { type: "string", description: "What was learned and why it changes the investigation." },
      },
      required: ["title", "markdown"],
      additionalProperties: false,
    },
  },
  {
    name: "flag_fact",
    description:
      "Challenge one verified fact only after finding a concrete contradiction or disproof. " +
      "The reason becomes a correction claim and is independently verified. General doubt is not enough; " +
      "a trajectory may use this tool at most once.",
    inputSchema: {
      type: "object",
      properties: {
        factId: { type: "string", description: "The F-prefixed fact ID." },
        reason: { type: "string", description: "One short paragraph giving the concrete contradiction or disproof." },
      },
      required: ["factId", "reason"],
      additionalProperties: false,
    },
  },
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
      "Use source_open to inspect the original text on demand.",
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

/**
 * Exact allow-list passed to the Codex CLI for Inventio's authenticated local
 * MCP server. The server still returns a role-appropriate subset and enforces
 * every read/write permission against the task token.
 */
export const MODEL_TOOL_NAMES = MODEL_TOOL_DEFINITIONS.map((tool) => tool.name);

/** The recurrent filesystem tools replace the older card/claim tool surface. */
export const RESEARCH_TOOL_DEFINITIONS: Tool[] = [
  { name: "research_search", description: "Search the saved mathematical filesystem by text. Researchers can find every saved note and result version. Independent checks see only their authorized mathematical versions, without prior verdicts or author identities.", inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 } }, required: ["query"], additionalProperties: false } },
  { name: "research_open", description: "Read a saved mathematical document by its stable ID. Reads are bounded and return the next character offset when more remains; document IDs never grant host filesystem access.", inputSchema: { type: "object", properties: { id: { type: "string" }, start: { type: "integer", minimum: 0 }, maxCharacters: { type: "integer", minimum: 1, maximum: 30000 } }, required: ["id"], additionalProperties: false } },
  { name: "research_checkpoint", description: "At a natural pause, publish immutable snapshots of all mathematical files under notes/ and optionally submit self-contained results. Drafts are catalogued automatically. This does not finish your conversation or promote a result.", inputSchema: toJsonSchema(z.object({ results: z.array(ResultSubmission).max(24).default([]) })) as Tool["inputSchema"] },
  { name: "audit_assess", description: "Record an independent assessment of one authorized exact result version. A concrete mathematical objection immediately affects that version's eligibility and its dependents. You cannot rewrite or erase the author's proof.", inputSchema: toJsonSchema(z.object({ assessment: Assessment })) as Tool["inputSchema"] },
  ...MODEL_TOOL_DEFINITIONS.filter(tool => tool.name === "source_list" || tool.name === "source_open"),
];
