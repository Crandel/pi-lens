#!/usr/bin/env node
/**
 * Run `tsc --project <tsconfig> --noCheck` (the first step of `build:dist`)
 * through the same `npm exec --package` isolation scripts/bundle-dist.mjs
 * uses for its esbuild spawn — see scripts/lib/exec-isolation.mjs for why.
 *
 * WHY `typescript` GOES THROUGH `npm exec` AT ALL (#437, #2593)
 * `typescript` is a genuine top-level devDependency, so under a normal
 * install `node_modules/.bin/tsc` already exists and this indirection is
 * unnecessary there. But `build:dist` also runs from a from-source
 * `--omit=dev` install (a `git:` install's `prepare` step, before any dev
 * tooling is present) where that symlink does NOT exist; `npm exec
 * --package typescript@<version>` resolves (or installs into npm's own
 * cache) a matching `tsc` in either case, mirroring the exact
 * resolve-your-own-toolchain approach already used for esbuild.
 *
 * WHY THE `--prefix` ISOLATION (#2593, refs #2590)
 * `npm exec --package` resolves against the WHOLE project dependency tree
 * (every nested `node_modules`), not just the npx cache — see
 * scripts/lib/exec-isolation.mjs. No dependency nests a matching
 * `typescript@7.0.2` anywhere in this repo's tree today (confirmed via
 * package-lock.json), so this is a latent-class hardening rather than a
 * currently-reproducible failure, applied defense-in-depth for the same
 * reason #2590 fixed the esbuild spawn: a future dependency bump could nest
 * one, exactly like `@earendil-works/pi-coding-agent` did for esbuild.
 *
 * `cwd: root` (unchanged from before this fix, and unlike esbuild's
 * banner-comment hazard) has no emitted-path hazard for tsc here:
 * `tsconfig.dist.json`'s `rootDir`/`outDir` are resolved relative to the
 * TSCONFIG FILE's own directory (project root), not the invocation `cwd`,
 * and with `sourceMap`/`declaration`/`declarationMap` all off (see
 * tsconfig.dist.json), `--noCheck` emit writes no cwd-relative path into
 * any output file.
 *
 * USAGE
 *   node scripts/build-dist-tsc.mjs <tsconfig-path>
 *   # invoked by `npm run build:dist`, before `npm run bundle:dist`
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	buildIsolatedExecInvocation,
	createIsolatedExecPrefix,
} from "./lib/exec-isolation.mjs";

const TSC_VERSION = "7.0.2";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// npm's own CLI, set by npm when it runs this via `npm run build:dist` — see
// scripts/bundle-dist.mjs's identical check for the full rationale.
const npmCli = process.env.npm_execpath;
const isNpmCli = npmCli
	? /npm-cli\.js$|(^|[\\/])npm(\.js)?$/.test(npmCli)
	: false;

/**
 * Build the argv + spawn options for the tsc `npm exec` invocation. Pure and
 * side-effect-free, mirroring buildEsbuildExecInvocation in
 * scripts/bundle-dist.mjs — see tests/scripts/build-dist-tsc.test.ts.
 *
 * @param {{ npmCli: string, execPrefix: string, tsconfigProject: string }} args
 * @returns {{ command: string, argv: string[], options: { cwd: string, stdio: "inherit" } }}
 */
export function buildTscExecInvocation({
	npmCli: npmCliPath,
	execPrefix,
	tsconfigProject,
}) {
	return buildIsolatedExecInvocation({
		npmCli: npmCliPath,
		execPrefix,
		cwd: root,
		packageSpec: `typescript@${TSC_VERSION}`,
		execArgv: ["tsc", "--project", tsconfigProject, "--noCheck"],
	});
}

export function main() {
	const tsconfigProject = process.argv[2];
	if (!tsconfigProject) {
		console.error(
			"[build-dist-tsc] usage: node scripts/build-dist-tsc.mjs <tsconfig-path>",
		);
		process.exit(1);
	}
	if (!npmCli) {
		console.error(
			"[build-dist-tsc] npm_execpath unset — run via `npm run build:dist`.",
		);
		process.exit(1);
	}
	if (!isNpmCli) {
		console.error(
			`[build-dist-tsc] npm_execpath is not npm (${npmCli}) — this step uses ` +
				"npm's `exec --package` syntax. Run `npm run build:dist` with npm.",
		);
		process.exit(1);
	}

	// mkdtempSync runs inside the try so a TMPDIR failure surfaces through the
	// existing "[build-dist-tsc] tsc failed: …" message rather than an
	// uncaught stack trace, mirroring scripts/bundle-dist.mjs (#2594 review
	// F3). No retry/fallback: there is no recorded recurrence of mkdtemp
	// failing here, so none is built for it.
	let execPrefix;
	let tscFailed = false;
	try {
		execPrefix = createIsolatedExecPrefix();
		const { command, argv, options } = buildTscExecInvocation({
			npmCli,
			execPrefix,
			tsconfigProject,
		});
		execFileSync(command, argv, options);
	} catch (err) {
		console.error(`[build-dist-tsc] tsc failed: ${err?.message ?? err}`);
		tscFailed = true;
	} finally {
		if (execPrefix) {
			rmSync(execPrefix, { recursive: true, force: true });
		}
	}
	if (tscFailed) {
		process.exit(1);
	}
}

const invokedPath = process.argv[1];
const invokedDirectly =
	typeof invokedPath === "string" &&
	pathToFileURL(path.resolve(invokedPath)).href === import.meta.url;
if (invokedDirectly) {
	main();
}
