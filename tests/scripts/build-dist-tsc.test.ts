import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildTscExecInvocation } from "../../scripts/build-dist-tsc.mjs";
import { createIsolatedExecPrefix } from "../../scripts/lib/exec-isolation.mjs";

// #2593: build:dist's `npx --yes -p typescript@7.0.2 tsc --project
// tsconfig.dist.json --noCheck` shares the EXACT same npm-exec resolution
// mechanism as #2590's fixed esbuild spawn in scripts/bundle-dist.mjs — both
// are npm's `exec --package`/`-p` syntax, run with cwd at the project root.
// `npm exec --package` resolves against the WHOLE project dependency tree
// (every nested node_modules, not just top-level deps), not just the npx
// cache; if a dependency ever nests a matching `typescript@7.0.2` copy
// anywhere, npm would treat the package as already present, skip the
// npx-cache install, and hand the child a PATH with no `tsc` binary at all —
// see scripts/lib/exec-isolation.mjs's header comment for the full
// mechanism writeup (shared with #2590's original finding).
//
// Unlike #2590, this is currently LATENT: `typescript` is a genuine
// top-level devDependency and no dependency nests a second matching copy
// anywhere in this repo's tree today (confirmed via package-lock.json), so
// there is no natural collision to reproduce. This test instead pins the
// exact production argv+options the same way
// tests/scripts/bundle-dist.test.ts's "buildEsbuildExecInvocation (#2594
// review F2)" pins the esbuild call site: a test that only exercised the
// shared builder or the prefix resolver in isolation would stay green even
// if this call site stopped using either (e.g. reverting to `cwd:
// execPrefix`, or dropping `--prefix` entirely) — so this asserts the real
// argv+options object buildTscExecInvocation hands to `execFileSync`.
describe("buildTscExecInvocation (#2593, refs #2590)", () => {
	const root = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"..",
	);

	it("spawns with cwd: root and a --prefix pointing outside root", () => {
		const execPrefix = createIsolatedExecPrefix();
		try {
			const { options, argv } = buildTscExecInvocation({
				npmCli: "/fake/npm-cli.js",
				execPrefix,
				tsconfigProject: "tsconfig.dist.json",
			});

			// tsc has no esbuild-style emitted-path hazard (tsconfig.dist.json's
			// rootDir/outDir resolve relative to the tsconfig file's own
			// location, not cwd, and sourceMap/declaration are both off), but
			// cwd stays root regardless — unchanged from before this fix, and
			// asserted directly rather than inferred from the absence of a cwd
			// override.
			expect(options.cwd).toBe(root);

			// Load-bearing: without --prefix pointed outside root, npm's tree
			// lookup falls back to walking up from cwd (root), reintroducing the
			// same collision shape #2590 fixed for esbuild.
			const prefixIndex = argv.indexOf("--prefix");
			expect(prefixIndex).toBeGreaterThanOrEqual(0);
			const prefixArg = argv[prefixIndex + 1];
			expect(prefixArg).not.toBe(root);
			expect(path.relative(root, prefixArg ?? "").startsWith("..")).toBe(true);
		} finally {
			fs.rmSync(execPrefix, { recursive: true, force: true });
		}
	});

	it("passes --package typescript@<version> and the tsc invocation with the given project", () => {
		const execPrefix = createIsolatedExecPrefix();
		try {
			const { argv } = buildTscExecInvocation({
				npmCli: "/fake/npm-cli.js",
				execPrefix,
				tsconfigProject: "tsconfig.dist.json",
			});
			const packageIndex = argv.indexOf("--package");
			expect(packageIndex).toBeGreaterThanOrEqual(0);
			expect(argv[packageIndex + 1]).toMatch(/^typescript@\d+\.\d+\.\d+$/);

			const tscIndex = argv.indexOf("tsc");
			expect(tscIndex).toBeGreaterThanOrEqual(0);
			expect(argv[tscIndex + 1]).toBe("--project");
			expect(argv[tscIndex + 2]).toBe("tsconfig.dist.json");
			expect(argv).toContain("--noCheck");
		} finally {
			fs.rmSync(execPrefix, { recursive: true, force: true });
		}
	});
});
