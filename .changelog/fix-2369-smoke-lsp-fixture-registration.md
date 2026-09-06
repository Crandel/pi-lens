---
section: Fixed
---

- **Nightly tool-smoke**: the `--lsp` lane's five auxiliary rows (opengrep, ast-grep, zizmor, typos, ast-grep-baseline) went to zero on every nightly run since 2026-08-25. `scripts/smoke-tools.mjs` registered a fixture's temp workspace as a served session root (`initLSPConfig`) only for `disableServers` fixtures; once one of those ran, the session-root registry flipped from empty (fail-open) to non-empty and every later auxiliary fixture's own (unregistered) workspace was silently declined. Every fixture now registers its own workspace unconditionally, and a harness-level guard throws if a fixture is ever touched unregistered again. Product behavior was never affected — a single real workspace root is always registered in production.
