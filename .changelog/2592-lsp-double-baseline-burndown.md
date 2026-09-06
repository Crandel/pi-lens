---
section: Changed
---
- Migrated the last 18 hand-rolled `LSPService` test doubles (17 files) onto
  `makeLspServiceDouble`, emptying `tests/support/lsp-double-baseline.json`;
  the #2582 sweep is now a plain gate that reds on any new hand-rolled double.
  Test-only apart from one comment in `clients/pipeline.ts`.
