---
section: Changed
---
- Migrated the last 18 hand-rolled `LSPService` test doubles (17 files) onto
  `makeLspServiceDouble`, emptying `tests/support/lsp-double-baseline.json` so
  the #2582 sweep is a plain gate that reds on any new hand-rolled double, and
  removed the `typeof lspService.isSpawnInFlight === "function"` hedge in
  `clients/pipeline.ts` that existed only for that population.
