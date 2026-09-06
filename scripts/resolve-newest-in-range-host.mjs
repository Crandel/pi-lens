#!/usr/bin/env node
/**
 * Resolve the newest published version of a package that satisfies the
 * range declared in this repo's package.json `peerDependencies` — what
 * install-smoke.yml's PR-gating "newest-in-range" lane installs (#2613, the
 * #2590 recurrence). See scripts/lib/resolve-newest-in-range-host.mjs for
 * the pure selection logic and why the range is read from package.json
 * rather than duplicated as a workflow input.
 *
 * Usage: node scripts/resolve-newest-in-range-host.mjs <package-name>
 * Prints the resolved version to stdout on success, and (when run under
 * GitHub Actions) also appends `version=<resolved>` to $GITHUB_OUTPUT.
 *
 * Exit codes:
 *   0  resolved a version
 *   2  infra failure — bad usage, unreadable package.json, no declared
 *      range, or `npm view` itself failed
 *   4  the declared range matched no published, non-prerelease version
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import {
	pickNewestInRange,
	readPeerRange,
} from "./lib/resolve-newest-in-range-host.mjs";

function fail(code, message) {
	console.error(message);
	process.exit(code);
}

const packageName = process.argv[2];
if (!packageName) {
	fail(2, "usage: resolve-newest-in-range-host.mjs <package-name>");
}

let pkg;
try {
	pkg = JSON.parse(fs.readFileSync("package.json", "utf-8"));
} catch (err) {
	fail(2, `cannot read package.json: ${err instanceof Error ? err.message : err}`);
}

let range;
try {
	range = readPeerRange(pkg, packageName);
} catch (err) {
	fail(2, err instanceof Error ? err.message : String(err));
}

let versions;
try {
	const raw = execFileSync(
		"npm",
		["view", packageName, "versions", "--json"],
		{ encoding: "utf-8" },
	);
	versions = JSON.parse(raw);
} catch (err) {
	fail(
		2,
		`npm view ${packageName} versions --json failed: ${err instanceof Error ? err.message : err}`,
	);
}
if (!Array.isArray(versions)) {
	// A package with exactly one published version returns a bare string
	// (not an array) from `npm view ... versions --json` — treat it as a
	// singleton list rather than mis-parsing it as "no versions".
	versions = typeof versions === "string" ? [versions] : [];
}

const resolved = pickNewestInRange(versions, range);
if (!resolved) {
	fail(
		4,
		`no published, non-prerelease version of ${packageName} satisfies peerDependencies range "${range}"`,
	);
}

console.log(resolved);
const githubOutput = process.env.GITHUB_OUTPUT;
if (githubOutput) {
	fs.appendFileSync(githubOutput, `version=${resolved}\n`);
}
