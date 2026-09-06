---
section: Fixed
---

- **`lens_diagnostics mode=full` and `--lens-guard` now treat a test RUNNER error as advisory, matching the turn-end message (closes #2532)** — a
  timeout, missing provider/binary, or configuration error (the suite itself
  never produced a verdict) rendered as a `blocking` finding in
  `testResultToProjectDiagnostics` and flipped `hasBlockers: true` under the
  experimental `--lens-guard` merge, while #2522 already delivers the
  identical event as advisory in the turn-end context message. Both
  consumers now route through the single `isRunnerErrorResult` classifier
  (`test-runner-client.ts`) the turn-end path already used, so a runner
  error reads as advisory everywhere and a genuine failing test stays
  blocking everywhere.
