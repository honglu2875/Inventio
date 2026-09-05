# Historical archive boundary

`archive.ts` replays saved `council-v1` and `trajectories-v2` events through the unchanged shared
schema reducer. A missing workflow on the creation event also means council.
It exposes only state, events, task evidence, and saved settings. It does not
open an append handle, acquire a writer lease, repair files, synchronize
uploads, register worker memory, resume threads, or launch a model.

`acceptance.ts` preserves the historical pure acceptance predicate for
compatibility tests. It is not imported by the active engine and does not
accept or alter an archived result. Saved verdicts retain their original
meaning.

The manager keeps archives and active recurrent engines separate. Mutation
routes require an active engine and return HTTP 409 for an archive. Cloning
intake is permitted because it creates a separate recurrent-v3 project;
no historical claims, verdicts, or threads are copied into the new run.

Trajectory and council scheduling, worker packet composition, model-controller prompts,
cross-examination, synthesis and curation execution have been removed. Event
schemas, reducer cases, historical graph/library projections, and source and
artifact readers remain for replay. The archive never guesses a repair for a
corrupt event log.
