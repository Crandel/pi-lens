import { describe, expect, it } from "vitest";
import {
	buildInstallSmokeDriftBody,
	buildInstallSmokeDriftComment,
	firstFailingStep,
	hasDrift,
} from "../../scripts/lib/install-smoke-drift.mjs";

const cleanReport = {
	version: "0.86.0",
	steps: [
		{ name: "pin devDependency + install", outcome: "success" as const },
		{ name: "build:dist", outcome: "success" as const },
		{ name: "npm pack", outcome: "success" as const },
		{ name: "install tarball", outcome: "success" as const },
		{ name: "install-selftest", outcome: "success" as const },
	],
};

const failingReport = {
	version: "0.86.0",
	steps: [
		{ name: "pin devDependency + install", outcome: "success" as const },
		{ name: "build:dist", outcome: "failure" as const },
		{ name: "npm pack", outcome: "skipped" as const },
		{ name: "install tarball", outcome: "skipped" as const },
		{ name: "install-selftest", outcome: "skipped" as const },
	],
};

// The very first step (resolving @latest itself) failing, with everything
// after it consequently "skipped" -- this must NOT read as a clean run.
// Before the CLI included this step in its report, a total registry failure
// during resolution left every OTHER outcome "skipped" (never "failure"),
// so hasDrift() saw no failure at all and the nightly lane silently closed
// (or never opened) its tracker on the exact failure it exists to catch.
const resolveFailedReport = {
	version: "unknown",
	steps: [
		{ name: "resolve @latest", outcome: "failure" as const },
		{ name: "install deps (ci)", outcome: "skipped" as const },
		{ name: "build:dist", outcome: "skipped" as const },
	],
};

describe("firstFailingStep / hasDrift (#2613)", () => {
	it("returns null and false for an all-success report", () => {
		expect(firstFailingStep(cleanReport)).toBeNull();
		expect(hasDrift(cleanReport)).toBe(false);
	});

	it("names the FIRST failing step and reports drift", () => {
		expect(firstFailingStep(failingReport)).toBe("build:dist");
		expect(hasDrift(failingReport)).toBe(true);
	});

	it("reports drift when only the FIRST step (resolve) failed and everything after it was skipped", () => {
		expect(firstFailingStep(resolveFailedReport)).toBe("resolve @latest");
		expect(hasDrift(resolveFailedReport)).toBe(true);
	});
});

describe("buildInstallSmokeDriftBody (#2613)", () => {
	it("names the installed version and the failing step", () => {
		const body = buildInstallSmokeDriftBody(failingReport);
		expect(body).toContain("@earendil-works/pi-coding-agent@0.86.0");
		expect(body).toContain("Installed version: **0.86.0**");
		expect(body).toContain("Failing step: **build:dist**");
		expect(body).toContain("| build:dist | failure |");
		expect(body).toContain("closed automatically once a nightly run");
	});

	it("includes the run link when provided", () => {
		const body = buildInstallSmokeDriftBody(failingReport, {
			runUrl: "https://example.test/run/1",
		});
		expect(body).toContain("Workflow run: https://example.test/run/1");
	});
});

describe("buildInstallSmokeDriftComment (#2613)", () => {
	it("names the installed version and failing step", () => {
		expect(buildInstallSmokeDriftComment(failingReport)).toBe(
			"Still failing: installed 0.86.0, failing step: build:dist.",
		);
	});
});
