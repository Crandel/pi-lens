---
section: Changed
---

- **Test names state behavior, not hope (closes #2602)** — the ~50 remaining `it("should …")` / `test("should …")` names under `tests/` are renamed to declarative present-tense behavior statements ("does X if Y") per AGENTS.md test-authoring screen 11. String-only rename: no assertion, fixture, or ordering changes.
