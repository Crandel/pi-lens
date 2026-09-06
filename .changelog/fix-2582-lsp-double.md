---
section: Changed
---

- **Consolidate LSP service test doubles (refs #2582)** — Pipeline and runtime-session fixtures now share one `LSPService` double, and the post-autofix LSP resync starts the primary `touchFile` before kicking off auxiliary server warmup so a failure in the best-effort auxiliary path can never abandon the primary sync or its `lsp_sync_abandoned` record.
