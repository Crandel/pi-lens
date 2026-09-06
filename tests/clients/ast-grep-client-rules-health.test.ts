import * as fsSync from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// #2626 review round 2, F5 pattern: capture logLatency calls to prove the
// success-path observability record fires and names the path + entry count.
const latencyEntries: Array<{
	phase?: string;
	filePath?: string;
	metadata?: Record<string, unknown>;
}> = [];
vi.mock("../../clients/latency-logger.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../../clients/latency-logger.js")>();
	return {
		...actual,
		logLatency: (entry: {
			phase?: string;
			filePath?: string;
			metadata?: Record<string, unknown>;
		}) => latencyEntries.push(entry),
	};
});

import { AstGrepClient } from "../../clients/ast-grep-client.js";
import * as ruleManager from "../../clients/ast-grep-rule-manager.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	resetUserNotifier,
	wireUserNotifier,
} from "../../clients/user-notify.js";
import { removeTempDirSync } from "./test-utils.js";

/**
 * #2636 (the #2626 class sweep's ast-grep leg): `AstGrepClient`'s
 * constructor falls back to the bundled `rules/`
 * (`resolvePackagePath(import.meta.url, "rules")`) with no existence check
 * when the project has none of its own — same managed-cache-relocation gap
 * #2626 fixed for `skills/`. `checkAstGrepRulesHealth` is independently
 * pinned in `ast-grep-rule-manager.test.ts`; these tests pin the
 * CONSTRUCTOR's WIRING to it — is the check only called on the bundled
 * fallback branch, does it name the resolved path, and does an unhealthy
 * result reach the degradation ledger.
 */

const notified: Array<{ message: string; level: string | undefined }> = [];
let tmpDirs: string[] = [];
let cwdSpy: ReturnType<typeof vi.spyOn> | undefined;

function degradationGroup() {
	return getDegradationSummary().find(
		(g) => g.kind === "ast-grep-rules-dir-missing",
	);
}

function resolvedPhaseEntries() {
	return latencyEntries.filter(
		(entry) => entry.phase === "ast_grep_rules_resolved",
	);
}

beforeEach(() => {
	notified.length = 0;
	latencyEntries.length = 0;
	tmpDirs = [];
	resetDegradationLedger();
	wireUserNotifier(() => (message, level) => {
		notified.push({ message, level });
	});
});

afterEach(() => {
	cwdSpy?.mockRestore();
	cwdSpy = undefined;
	resetUserNotifier();
	resetDegradationLedger();
	vi.restoreAllMocks();
	for (const dir of tmpDirs) {
		removeTempDirSync(dir);
	}
});

function tempCwdWithoutRules(): string {
	const dir = fsSync.mkdtempSync(
		path.join(os.tmpdir(), "pilens-ast-grep-client-cwd-"),
	);
	tmpDirs.push(dir);
	return dir;
}

describe("AstGrepClient constructor — bundled rules health wiring (#2636)", () => {
	it("does NOT check bundled health when the project provides its own rules/ (this repo's own layout)", () => {
		// This repo's cwd (the real test-run cwd) has a real `rules/` directory,
		// so the constructor picks the PROJECT override and never reaches the
		// bundled-fallback branch — negative control mirroring #2626's
		// index-wiring negative control.
		void new AstGrepClient();
		expect(resolvedPhaseEntries()).toEqual([]);
		expect(degradationGroup()).toBeUndefined();
		expect(notified).toHaveLength(0);
	});

	it("checks bundled health and logs the phase record when the project has no rules/", () => {
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tempCwdWithoutRules());

		void new AstGrepClient();

		// The real bundled rules/ (this repo's own, resolved via
		// AstGrepClient's fixed import.meta.url) IS healthy, so this proves the
		// WIRING reaches the check on the fallback branch without asserting a
		// bug that isn't present in this repo's own installed layout.
		expect(resolvedPhaseEntries()).toHaveLength(1);
		expect(resolvedPhaseEntries()[0].metadata).toMatchObject({
			status: "healthy",
		});
		expect(
			(resolvedPhaseEntries()[0].metadata as { entryCount: number }).entryCount,
		).toBeGreaterThan(0);
		expect(degradationGroup()).toBeUndefined();
	});

	it("records a bounded degradation + notify when the bundled rules/ is unhealthy", () => {
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tempCwdWithoutRules());
		const healthSpy = vi
			.spyOn(ruleManager, "checkAstGrepRulesHealth")
			.mockReturnValue({ status: "absent" });

		void new AstGrepClient();

		expect(healthSpy).toHaveBeenCalledTimes(1);
		const group = degradationGroup();
		expect(group).toBeDefined();
		expect(group?.count).toBe(1);
		expect(group?.latestReasons.at(-1)?.reason).toContain("no such directory");
		expect(notified).toHaveLength(1);
		expect(notified[0].message).toContain(
			"ast-grep rule descriptions unavailable",
		);
		expect(resolvedPhaseEntries()[0].metadata).toMatchObject({
			status: "absent",
			entryCount: 0,
		});
	});

	it("does not re-notify on a second unhealthy construction in the same session", () => {
		cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(tempCwdWithoutRules());
		vi.spyOn(ruleManager, "checkAstGrepRulesHealth").mockReturnValue({
			status: "absent",
		});

		void new AstGrepClient();
		void new AstGrepClient();

		expect(notified).toHaveLength(1);
		expect(degradationGroup()?.count).toBe(2);
	});
});
