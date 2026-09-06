---
section: Changed
---

- **Test names state behavior, not hope (closes #2602)** — the 58 `it("should …")` / `test("should …")` names under `tests/` (including mid-string, not just leading, `should`) are renamed to declarative present-tense behavior statements ("does X if Y") per AGENTS.md test-authoring screen 11, and one exact duplicate test case is deleted. String-only rename elsewhere: no assertion, fixture, or ordering changes — except seven inert fixture-wrapper strings in `tree-sitter-new-blocker-rules.test.ts`, which are TypeScript source content fed to a tree-sitter query that never inspects them.
