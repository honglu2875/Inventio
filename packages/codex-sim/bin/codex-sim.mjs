#!/usr/bin/env node
import { main } from '../lib/run.mjs';

main().catch((err) => {
  try {
    process.stderr.write(`codex-sim: internal error: ${err?.stack ?? err}\n`);
  } catch {
    /* stderr closed */
  }
  process.exit(70);
});
