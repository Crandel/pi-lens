import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveBundleExecCwd } from "../../scripts/bundle-dist.mjs";

// #2590: `npm exec --package esbuild@<ESBUILD_VERSION>` resolves against the
// FULL project dependency tree (libnpmexec's `missingFromTree` queries
// Arborist's whole inventory — every nested node_modules, not just top-level
// deps), not just the npx cache. When a dependency happens to nest an
// `esbuild` matching ESBUILD_VERSION (e.g. `@earendil-works/pi-coding-agent`
// -> `@earendil-works/chord` -> `esbuild@0.28.1`), npm finds that nested copy
// "already satisfying" the request, skips its npx-cache install entirely, and
// — because `binPaths` is only populated on the separate bare-`npx <bin>`
// swap path, never on this explicit `--package` path — hands the child a PATH
// with no esbuild binary at all: `sh: 1: esbuild: not found`, reproduced
// verbatim against the #2588 worktree (real dependency tree, real npm exec):
//
//   $ npm exec --yes --package esbuild@0.28.1 -- esbuild --version   # cwd = project root
//   sh: 1: esbuild: not found
//   $ npm exec --yes --package esbuild@0.28.1 -- esbuild --version   # cwd = fresh mktemp -d
//   0.28.1
//
// `resolveBundleExecCwd()` is the fix: the cwd passed to that `npm exec`
// spawn must have no package.json anywhere in its ancestry, so Arborist's
// tree is always empty and npm always installs into its own npx cache.
// Faithfully reproducing npm's real Arborist-based resolution against a fixed
// tree in a hermetic test would mean reimplementing it, so this test targets
// the cwd decision directly and pure: not the project root, and sharing no
// package.json with it in either direction.
describe("resolveBundleExecCwd (#2590)", () => {
	const root = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
	);

	it("returns a directory that is neither the project root, an ancestor of it, nor a descendant of it", () => {
		const cwd = resolveBundleExecCwd();
		try {
			expect(cwd).not.toBe(root);

			// Not a descendant of root: walking from root to cwd must leave root
			// (a relative path starting with "..") rather than staying inside it.
			const fromRoot = path.relative(root, cwd);
			expect(fromRoot.startsWith("..")).toBe(true);

			// Not an ancestor of root either: walking from cwd to root must leave
			// cwd, not stay inside it.
			const toRoot = path.relative(cwd, root);
			expect(toRoot.startsWith("..")).toBe(true);

			// It has to actually exist for npm to spawn in it.
			expect(fs.statSync(cwd).isDirectory()).toBe(true);
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("creates a fresh directory under the OS temp dir on every call", () => {
		const first = resolveBundleExecCwd();
		const second = resolveBundleExecCwd();
		try {
			expect(first).not.toBe(second);
			const tmp = fs.realpathSync(os.tmpdir());
			for (const dir of [first, second]) {
				const real = fs.realpathSync(dir);
				expect(real === tmp || !path.relative(tmp, real).startsWith("..")).toBe(
					true,
				);
			}
		} finally {
			fs.rmSync(first, { recursive: true, force: true });
			fs.rmSync(second, { recursive: true, force: true });
		}
	});
});
