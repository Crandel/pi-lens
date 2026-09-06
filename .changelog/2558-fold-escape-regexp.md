---
section: Changed
---

- **`escapeRegExp` folded onto one runtime export (refs #2558)** — the regex-escaping helper (and its near-namesakes `escapeRegExpChar`/`escapeRegExpLiteral`/a renamed `escapeRegex`) was hand-copied into eight production modules and four test helpers with a byte-identical body. `clients/string-utils.ts` now owns the one runtime copy and `tests/support/sweep-kit.ts` re-exports it for tests; every former copy imports from one of those instead. A new `tests/config/escape-regexp-fold-sweep.test.ts` guard flags a future re-copy by matching the escaping BODY (not the function's name), so a renamed copy is caught the same way the original `escapeRegex` rename in `scripts/lib/astgrep-self-scan.mjs` was. `clients/file-utils.ts`'s `globToRegExp` keeps its own narrower character class (it omits glob wildcards `*`/`?`, which its caller handles separately) as a documented variant, not a copy.
