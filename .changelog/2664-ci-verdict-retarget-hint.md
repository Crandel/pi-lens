---
section: Fixed
---

- **`ci-verdict.mjs`'s absent-required-checks reason now says why (refs #2664)** — when both required checks are absent and the PR is not merge-conflicted, the exit code was already 3 (pending, not 0) since #2539/#2609, but the printed reason now ends with "base retargeted? push a commit or close/reopen to re-arm ci.yml" for the concrete scenario that prompted the report: a base retargeted after the PR opened, which `ci.yml` never re-registers against since it has no `edited` trigger.
