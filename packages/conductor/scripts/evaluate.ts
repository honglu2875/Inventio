import { readEvaluationCases } from "../src/evaluation/readCases.js";
import { scoreVerifications } from "../src/evaluation/score.js";

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--manifest") {
  console.error("Usage: npm run evaluate -w @inventio/conductor -- --manifest /path/to/local-cases.json");
  process.exitCode = 2;
} else {
  try {
    process.stdout.write(JSON.stringify(scoreVerifications(readEvaluationCases(args[1]!)), null, 2) + "\n");
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
