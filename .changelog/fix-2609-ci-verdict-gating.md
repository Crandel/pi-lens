---
section: Fixed
---

- **`ci-verdict.mjs` gates on every check-run, not just Unit tests/Lint (closes #2609)** — The merge-train's CI-verdict read used to inspect only the fixed `Unit tests`/`Lint & type-check` pair, so a red `Production install build` or `Install test` job (found on PR #2588) was reported as "both required checks concluded success." Every check-run GitHub reports on the head is now a row, and every row gates the exit code unless it is on the shared advisory allowlist (`scripts/lib/ci-checks.mjs`, the same list the real merge-train gate already uses) or its conclusion is `skipped`/`neutral`. `run()` also reads `master`'s live branch-protection required checks via `gh api` when readable and states which source drove the verdict.
