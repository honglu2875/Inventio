/**
 * Build-authoring script (run once, output committed):
 *
 *   npx tsx packages/ui/scripts/make-fixture.mjs
 *
 * Converts the schema package's canonical event sequence into a static JSON
 * asset under src/fixtures/. The app never imports schema test files at
 * runtime — it loads the generated JSON (UI-SPEC §3, fixture replay mode).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCanonicalEvents } from "../../schema/test/fixtures.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../src/fixtures");
const outFile = path.join(outDir, "happy.json");

const events = buildCanonicalEvents();
mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, `${JSON.stringify(events, null, 2)}\n`, "utf8");

console.log(`wrote ${events.length} events → ${path.relative(process.cwd(), outFile)}`);
