---
section: Fixed
---

- **Infra-kill auto-rerun now covers master pushes, not only PRs (closes #2668)** —
  `.github/workflows/ci-infra-kill-rerun.yml` gated on
  `workflow_run.event == 'pull_request'`, so a Unit-tests job killed by
  infrastructure (exit 137, `[mem-watch] KILLED WITH HEADROOM`, no failing
  assertion) on a push to `master` was never classified or rerun and stayed
  red until someone reran it by hand. The job now also matches a same-repo
  push to `master`, and the classifier gained an `allowMissingPr` mode: a
  push run's `pull_requests` array is always empty, so with the flag set
  classification and the one-shot rerun (still bounded by the existing
  `run_attempt == 1` gate) proceed while every PR-comment step is skipped —
  there is no issue thread to post to.
