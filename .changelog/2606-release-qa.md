---
section: Added
---

- **Release-readiness QA pass: a witnessed feature × modality matrix against a real pi (refs #2606)** —
  `docs/release-qa-baseline.md` enumerates eleven rows across five modalities
  (published tarball, npm install, headless `pi --mode rpc`, the MCP stdio
  server, and a `git:` install), each with the command or RPC a user path
  actually takes, a concrete pass criterion, and the witness to capture.
  `scripts/release-qa.mjs` runs that matrix against a real pi in a scratch
  `HOME`, writes `release-qa-report.md` plus one witness file per row, and
  reports every row as PASS, FAIL with its cause, UNTESTED with its reason, or
  SKIPPED — with the `discovered / rows / untested` arithmetic printed rather
  than claimed, an expired polling cap counted UNTESTED and never PASS, and no
  ship verdict at all when pi cannot boot. The `release-qa` skill drives the
  pass, and AGENTS.md now requires it before a release is cut.
