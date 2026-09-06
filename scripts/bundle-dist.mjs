#!/usr/bin/env node
/**
 * Bundle the compiled extension entry (`dist/index.js`) into a single
 * self-contained ESM file, inlining pure-JS runtime dependencies.
 *
 * WHY THIS EXISTS
 * pi ships as a `bun build --compile` single-file executable and loads
 * extensions inside that embedded runtime. That runtime's module resolver does
 * not traverse an extension's on-disk `node_modules` for a BARE specifier (e.g.
 * `import "minimatch"`), so analyzers that transitively import third-party deps
 * (minimatch via `file-utils.js` -> jscpd/todo/complexity) fail to load
 * ("Cannot find package 'minimatch' …") and drop to degraded mode. Bundling
 * inlines those deps so the extension imports nothing by bare specifier at load
 * time. Runs after `tsc` (build:dist) has produced `dist/`; bundles in place.
 *
 * KEPT EXTERNAL (not inlined)
 *   The list lives in ./lib/host-provided-deps.mjs, which is also what
 *   package.json's dependency shape and tests/packaging.test.ts are pinned to
 *   (#1926). Two reasons a package is external:
 *   - Host-provided: pi resolves it from its own embedded runtime, so the
 *     extension must NOT declare it as a runtime dependency.
 *   - Native addon / wasm loaded lazily by absolute path at call time.
 *   node: builtins are external by default.
 *
 * esbuild is run through `npm exec` (resolved from npm's own CLI so there is no
 * npx `.cmd` shim and no shell), the same resolve-your-own-toolchain approach
 * build:dist uses for tsc (#437): esbuild installs into npm's cache, never the
 * project tree, so this adds no dependency and works under a from-source
 * `--omit=dev` install where project devDeps are absent. This relies on npm's
 * `exec --package` syntax; pi always installs via npm so the shipping path is
 * npm. A non-npm `npm_execpath` (pnpm/yarn/bun) is rejected with a clear error.
 *
 * WHY THE SPAWN RUNS FROM A TEMP CWD, NOT `root` (#2590)
 * `npm exec --package <spec>` does not only check the npx cache: npm's
 * libnpmexec builds an Arborist tree rooted at the spawn's cwd
 * (`localArb.loadActual()`) and, for each `--package` spec, queries that
 * tree's FULL inventory (every nested `node_modules`, not just top-level
 * deps) for a version satisfying the spec. If ANY nested copy matches — e.g.
 * a transitive dependency that happens to vendor an `esbuild` at
 * `ESBUILD_VERSION` — npm treats the package as already present and skips
 * the npx-cache install entirely. `binPaths` (what gets prepended to the
 * child's PATH) is populated only on the separate bare-`npx <bin>` swap path,
 * never on this explicit `--package` path, so the matched-but-not-linked
 * nested copy leaves the child with no esbuild anywhere on PATH at all —
 * `esbuild: not found`, reproduced verbatim when
 * `@earendil-works/pi-coding-agent` nested a transitive `esbuild@0.28.1`.
 * Running the spawn from a freshly created temp directory with no
 * `package.json` anywhere in its ancestry gives Arborist an empty tree, so
 * this is independent of whatever the project's own `node_modules` contains.
 * `distEntry` and the esbuild `--outfile` are both already absolute paths, so
 * nothing about the actual bundling is affected by the child's cwd.
 *
 * USAGE
 *   node scripts/bundle-dist.mjs   # invoked by `npm run bundle:dist`
 */
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BUNDLE_EXTERNALS } from "./lib/host-provided-deps.mjs";

const ESBUILD_VERSION = "0.28.1";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distEntry = path.join(root, "dist", "index.js");
const tmpOut = path.join(root, "dist", "index.bundled.mjs");

// Packages the bundle must NOT inline: host-provided ones resolve from pi's
// embedded runtime; native/wasm ones are dynamic-imported by absolute path.
// Single source of truth — see ./lib/host-provided-deps.mjs (#1926).
const EXTERNAL = BUNDLE_EXTERNALS;

// esbuild's ESM output wraps bundled CommonJS modules (e.g. vscode-jsonrpc) in a
// shim that throws on any dynamic require(); a pure-ESM Node process has no
// ambient require. Prepend a real one so those bundled CJS deps resolve at load.
const REQUIRE_BANNER =
	'import { createRequire as __pilensCreateRequire } from "node:module"; const require = __pilensCreateRequire(import.meta.url);';

// npm's own CLI, set by npm when it runs this via `npm run bundle:dist`. Running
// esbuild through `node <npm-cli> exec` (rather than the `npx`/`npx.cmd` shim)
// keeps the spawn shell-free and cross-platform, so args are never re-parsed by
// a shell. This uses npm's `exec --package` syntax specifically; pnpm/yarn/bun
// expose a different exec/dlx surface, so the invocation is intentionally
// npm-only (pi always installs via npm, so the shipping path is npm) and we
// reject a non-npm `npm_execpath` with a clear message rather than passing
// npm flags to another package manager's CLI.
const npmCli = process.env.npm_execpath;
const isNpmCli = npmCli
	? /npm-cli\.js$|(^|[\\/])npm(\.js)?$/.test(npmCli)
	: false;

/**
 * cwd for the `npm exec --package esbuild@…` spawn — see the header comment
 * "WHY THE SPAWN RUNS FROM A TEMP CWD, NOT `root`" (#2590). Must have no
 * `package.json` anywhere in its ancestry, so npm's Arborist-based
 * `exec --package` resolution always sees an empty dependency tree and
 * installs into its own npx cache instead of matching a nested transitive
 * copy already present somewhere in the project's `node_modules`. A fresh
 * `mkdtemp` under the OS temp dir guarantees that: it is never inside `root`
 * and `root` is never inside it.
 *
 * Exported as a pure, directly testable unit — see
 * tests/scripts/bundle-dist.test.ts — since faithfully exercising npm's real
 * Arborist-based resolution in a test would mean reimplementing it.
 *
 * @returns {string} a freshly created, empty temporary directory
 */
export function resolveBundleExecCwd() {
	return mkdtempSync(path.join(os.tmpdir(), "pilens-bundle-"));
}

export function main() {
	if (!existsSync(distEntry)) {
		console.error(
			`[bundle] ${distEntry} not found — run build:dist (tsc) first.`,
		);
		process.exit(1);
	}
	// Idempotency guard: the bundle step rewrites dist/index.js IN PLACE, so a
	// second standalone `npm run bundle:dist` (without build:dist's fresh tsc
	// emit) would re-bundle the bundle and prepend the require banner a second
	// time — a duplicate `const require` declaration that fails to load
	// ("Identifier '__pilensCreateRequire' has already been declared"). Detect
	// the banner and no-op instead.
	if (readFileSync(distEntry, "utf8").startsWith(REQUIRE_BANNER)) {
		console.error(
			"[bundle] dist/index.js is already bundled — skipping (run build:dist for a fresh emit).",
		);
		process.exit(0);
	}
	if (!npmCli) {
		console.error(
			"[bundle] npm_execpath unset — run via `npm run bundle:dist`.",
		);
		process.exit(1);
	}
	if (!isNpmCli) {
		console.error(
			`[bundle] npm_execpath is not npm (${npmCli}) — this step uses npm's ` +
				"`exec --package` syntax. Run `npm run bundle:dist` with npm.",
		);
		process.exit(1);
	}

	const execCwd = resolveBundleExecCwd();
	let bundleFailed = false;
	try {
		execFileSync(
			process.execPath,
			[
				npmCli,
				"exec",
				"--yes",
				"--package",
				`esbuild@${ESBUILD_VERSION}`,
				"--",
				"esbuild",
				distEntry,
				"--bundle",
				"--platform=node",
				"--format=esm",
				...EXTERNAL.map((name) => `--external:${name}`),
				`--outfile=${tmpOut}`,
			],
			{ cwd: execCwd, stdio: "inherit" },
		);
	} catch (err) {
		console.error(`[bundle] esbuild failed: ${err?.message ?? err}`);
		bundleFailed = true;
	} finally {
		// Tidiness, not correctness: npm's own package cache lives under npm's
		// cache dir, not this cwd, so nothing load-bearing is left behind here
		// either way — but don't leak temp directories on every build.
		rmSync(execCwd, { recursive: true, force: true });
	}
	if (bundleFailed) {
		process.exit(1);
	}

	// Prepend the require banner, then replace the tsc-emitted entry in place.
	writeFileSync(tmpOut, `${REQUIRE_BANNER}\n${readFileSync(tmpOut, "utf8")}`);
	renameSync(tmpOut, distEntry);
	console.error(
		`[bundle] wrote self-contained ${path.relative(root, distEntry)}`,
	);
}

const invokedPath = process.argv[1];
const invokedDirectly =
	typeof invokedPath === "string" &&
	pathToFileURL(path.resolve(invokedPath)).href === import.meta.url;
if (invokedDirectly) {
	main();
}
