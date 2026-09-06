---
section: Fixed
---

- **`pi.skills` no longer escapes the published package (closes #2587)** —
  the manifest entry pointed at `../../skills`, which resolves *outside* the
  installed package on every layout (npm, `git:` clones, managed caches). The
  four shipped skills still registered through the extension's own
  `resources_discover` handler, but where the escaped path landed on an
  existing directory (your project's `skills/`, or `<cache>/npm/skills`) pi
  adopted that foreign tree as a pi-lens package resource and a same-named
  entry there shadowed the real `pi-lens-ast-grep`,
  `pi-lens-lsp-navigation`, `pi-lens-write-ast-grep-rule` or
  `pi-lens-write-tree-sitter-rule`. pi resolves a non-glob manifest entry
  against the package root, so the entry is now `./skills` and only the
  package's own skills are registered.
