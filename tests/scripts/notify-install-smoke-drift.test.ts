// flake-shape: real-process-spawn — `--dry-run` is the ONE mode of this
// script that never shells out to `gh` (the real gh calls are untested here,
// same documented exception as tests/scripts/drift-issue.test.ts's sibling
// scripts/notify-clean-signal-drift.mjs), so a real spawn is the only way to
// prove the CLI's own env-reading/report-building wiring end to end without
// mocking child_process (#2613).
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const CLI = path.join(REPO_ROOT, "scripts/notify-install-smoke-drift.mjs");

function runDryRun(env: Record<string, string>) {
	return execFileSync(process.execPath, [CLI, "--dry-run"], {
		env: { ...process.env, ...env },
		encoding: "utf-8",
	});
}

describe("notify-install-smoke-drift.mjs --dry-run (#2613)", () => {
	it("plans a filing when a step failed", () => {
		const out = runDryRun({
			RESOLVED_VERSION: "0.86.0",
			INSTALL_DEPS_OUTCOME: "success",
			BUILD_DIST_OUTCOME: "failure",
			PACK_OUTCOME: "skipped",
			INSTALL_TARBALL_OUTCOME: "skipped",
			SELFTEST_OUTCOME: "skipped",
		});
		expect(out).toContain("drift=true");
		expect(out).toContain("Failing step: **build:dist**");
	});

	it("plans no filing (clean) when every step succeeded", () => {
		const out = runDryRun({
			RESOLVED_VERSION: "0.86.0",
			RESOLVE_OUTCOME: "success",
			INSTALL_CI_OUTCOME: "success",
			INSTALL_DEPS_OUTCOME: "success",
			GRAMMARS_OUTCOME: "success",
			BUILD_DIST_OUTCOME: "success",
			PACK_OUTCOME: "success",
			INSTALL_TARBALL_OUTCOME: "success",
			SELFTEST_OUTCOME: "success",
		});
		expect(out).toContain("drift=false");
	});

	// Review S2 correctness follow-through: a registry failure resolving
	// @latest itself (every later step consequently "skipped", never
	// "failure") must still read as drift -- see
	// tests/scripts/install-smoke-drift.test.ts for the pure-function proof;
	// this proves the CLI's env wiring actually reaches RESOLVE_OUTCOME.
	it("plans a filing when ONLY the resolve step failed (everything after it skipped)", () => {
		const out = runDryRun({
			RESOLVED_VERSION: "",
			RESOLVE_OUTCOME: "failure",
			INSTALL_CI_OUTCOME: "skipped",
			INSTALL_DEPS_OUTCOME: "skipped",
			GRAMMARS_OUTCOME: "skipped",
			BUILD_DIST_OUTCOME: "skipped",
			PACK_OUTCOME: "skipped",
			INSTALL_TARBALL_OUTCOME: "skipped",
			SELFTEST_OUTCOME: "skipped",
		});
		expect(out).toContain("drift=true");
		expect(out).toContain("Failing step: **resolve @latest**");
	});
});
