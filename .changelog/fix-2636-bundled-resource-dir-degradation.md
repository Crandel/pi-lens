---
section: Fixed
---

- **ast-grep / tree-sitter rules**: `AstGrepClient`'s bundled `rules/`
  fallback, `RuleCache`'s bundled `rules/tree-sitter-queries` root, and
  `ruleFilesForLanguage`'s bundled query directory now report a bounded
  `ast-grep-rules-dir-missing` / `tree-sitter-queries-dir-missing`
  degradation (extension warning + `pilens_health`) when the resolved
  bundled directory is absent, unreadable, or holds nothing — an installed
  copy missing the resource, or the entry file copied out of the package
  tree by a managed extension cache. A language with no bundled queries
  authored for it by design (cobol, plsql) still reports nothing, since the
  degradation checks the shared bundled ROOT's health, not any one
  language's subdirectory. Previously these three sites silently resolved
  to zero rules/queries with no signal, the same shape #2626 fixed for
  `resources_discover`'s `skills/` directory.
