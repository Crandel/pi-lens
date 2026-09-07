---
section: Changed
---

- **One fixture-workspace bootstrap for the five LSP dev-harness scripts, home-pinned (closes #2670, closes #2658)** — `scripts/lib/lsp-fixture-workspace.mjs`'s `bootstrapFixtureWorkspace` replaces the hand-copied "copy fixture → register session root → optional disable+reload → optional git init → assert registered" preamble in `smoke-tools.mjs`, `characterize-lsp.mjs`, `probe-clean-signal.mjs`, `server-capabilities.mjs`, and `bench-lsp.mjs` (the last one previously skipped the unconditional register entirely). `withScratchHome()` pins `PI_LENS_HOME`/`PILENS_DATA_DIR` to a scratch temp dir for every one of the five scripts, so their now-unconditional `initLSPConfig` calls no longer write `config_resolved` telemetry into a developer's real `~/.pi-lens`.
