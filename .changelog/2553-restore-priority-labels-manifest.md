---
section: Fixed
---

- **Label syncer no longer deletes the priority labels on every merge-train lane merge (refs #2553)** — `.github/workflows/labels.yml` runs `micnncim/action-label-syncer` with `prune: true` against `.github/labels.yml`, and the manifest never listed `priority:p1`/`p2`/`p3`, so every sync deleted them and stripped the label from every open issue. The three labels are now in the manifest (matching the live colors/descriptions), a comment above them documents the syncer's prune behavior for the next person adding a label by hand, and a new governance test (`tests/config/label-manifest-coverage.test.ts`) fails loud if the manifest ever again drops a label this repo's own rules require. Re-applying the stripped priorities to the 188 already-triaged issues is tracked separately in #2553.
