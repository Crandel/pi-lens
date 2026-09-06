---
section: Fixed
---

- **Resolve `bundle:dist`'s esbuild independent of the project tree (closes #2590)** — `scripts/bundle-dist.mjs` ran its `npm exec --package esbuild@<version>` spawn from the project root, so npm's Arborist-based resolution could match a nested transitive copy of esbuild anywhere in `node_modules` (not just the npx cache) and skip the real install, leaving the child with no esbuild binary on PATH (`esbuild: not found`). The spawn now runs from a freshly created, empty temp directory with no `package.json` in its ancestry, so npm always resolves esbuild from its own cache.
