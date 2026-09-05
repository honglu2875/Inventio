# Offline verification evaluation

Use an explicit local manifest to score saved checks without model calls or
project writes. Paths are relative to the manifest. Keep private manifests and
research text outside tracked fixtures, for example under /tmp.

```json
{
  "version": 1,
  "cases": [
    {
      "id": "example-proof-check-1",
      "variant": "saved-baseline",
      "eventsFile": "/absolute/path/to/selected/project/events.jsonl",
      "verificationId": "V001",
      "label": "UNLABELLED"
    }
  ]
}
```

```bash
npm run evaluate -w @inventio/conductor -- --manifest /tmp/local-cases.json
```

Labels are VALID_PROOF, INVALID_PROOF, INCOMPLETE_PROOF, or UNLABELLED.
They describe the submitted proof including its stated relation to the goal.
A theorem can be true while its submitted proof is invalid. Use an expert
label, not the verifier verdict, as ground truth. An opposing calculation
without a certified derivation remains UNLABELLED.

The report separates false acceptance, false rejection, undecided/error
checks, missing execution audits, evidence failures, and usage by variant.
Rate denominators include labelled abstentions; always compare decision
coverage alongside those rates. Missing usage is not measured as zero:
observedTokens totals only reported usage and meanTokens is null if any usage
is absent. Tokens mean uncached input plus output, not prices or dollar cost.

This scores individual verification decisions. It does not certify a theorem,
score the entire research trajectory, or establish the effect of prompt
changes. For paired trials, hold the model, proof version, tool environment,
and budget fixed and use the same labelled cases across variants. Keep
correct proofs, incomplete proofs, wrong computations and valid partial
results in the set. Report false acceptance separately for incomplete and
incorrect arguments when interpreting aggregate results. No live evaluation
has been run; a live trial requires explicit authorization.
