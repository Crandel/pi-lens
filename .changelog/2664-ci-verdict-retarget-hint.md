---
section: Fixed
---

- **`ci-verdict.mjs`'s absent-required-checks reason now says why (refs #2664)** — when both required checks are absent and the PR is not merge-conflicted, the exit code was already 3 (pending, not 0) since #2539/#2609, but the printed reason now ends with a conditional "if the base was retargeted after this PR opened, push a commit or close/reopen to re-arm ci.yml" for the scenario that prompted the report — `ci.yml` never re-registers against a retargeted base since it has no `edited` trigger. Phrased as a conditional, not a directive, since the far more common cause of this same verdict is a fresh push where CI simply has not registered yet, and an unconditional "push a commit" would tell that routine case's reader to restart all of CI for no reason.
