---
section: Fixed
---

- **Merge gate no longer false-fails on a concurrency-superseded cancelled check-run (closes #2632)** — `merge-train-lane.mjs`'s real `evaluateMergeGate` treated a discovered (non-required) check-run's `cancelled` conclusion the same as any other failure, but this repository's `cancel-in-progress: true` leaves a stale cancelled row as the only evidence for a check name for several minutes before its replacement posts (live-probed on PR #2607's "Record post-merge validation"). That row now reads as uncertain rather than failing, via the same `isUncertainConclusion` predicate `ci-verdict.mjs` already used (#2618) — a required check's (`Unit tests`, `Lint & type-check`) `cancelled` conclusion still fails outright, and a genuinely failing check is never masked by an older cancelled duplicate of the same name.
