/**
 * #2140 — the availability probe searched PATH only.
 *
 * `createAvailabilityChecker`'s resolver walked venv → npm managed shims →
 * bare command name, so a github/maven/archive-strategy tool installed only
 * into pi-lens's OWN release-managed directory (`~/.pi-lens/bin`, where
 * `ensureTool` puts it, and which `getToolEnvironment` prepends to every
 * spawn's PATH) missed the probe and latched a durable `unavailable`. The
 * install fallback then handed the caller the very binary sitting in that
 * directory a few hundred ms later — 7 unavailable/available pairs for
 * opengrep in one 3h dogfood window, gaps 625-2500ms, with the binary present
 * the whole time.
 *
 * The seam here is the REAL installer: `findManagedToolBinary` (the same
 * lookup `getToolPath` runs before PATH for exactly these strategies) and the
 * real tool registry, driven through the real `createAvailabilityChecker`.
 * Only the spawn boundary and the log sinks are doubles — a mocked
 * `findManagedToolBinary` would prove nothing about which directory the probe
 * consults or which tools it applies to.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeTempDirSync } from "../../test-utils.js";

const { piLensDirHolder, logLatencySpy } = vi.hoisted(() => ({
	piLensDirHolder: { dir: "" },
	logLatencySpy: vi.fn(),
}));

// The installer captures `GITHUB_BIN_DIR` at module load, so the redirect has
// to be in place before the fresh import each test takes (`vi.resetModules`).
vi.mock("../../../../clients/file-utils.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/file-utils.js")
	>()),
	getGlobalPiLensDir: () => piLensDirHolder.dir,
}));

vi.mock("../../../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../../clients/latency-logger.js")
	>()),
	logLatency: logLatencySpy,
}));

vi.mock("../../../../clients/sessionstart-logger.js", () => ({
	logSessionStart: vi.fn(),
}));

vi.mock("../../../../clients/safe-spawn.js", () => ({
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 1 })),
	safeSpawnAsync: vi.fn(async () => ({ stdout: "", stderr: "", status: 1 })),
}));

const enoent = () => ({
	stdout: "",
	stderr: "",
	status: null,
	error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }),
	failure: "spawn" as const,
	spawnFailure: { kind: "tool-not-found" } as never,
});

const versionOk = () => ({ stdout: "1.7.7", stderr: "", status: 0 });

const decisions = () =>
	logLatencySpy.mock.calls
		.map((call) => call[0])
		.filter((entry) => entry?.phase === "availability_decision");

let tmpHome = "";
let cwd = "";

/**
 * `actionlint` is `installStrategy: "github"` in the registry, so the managed
 * install lands in `<pi-lens home>/bin`. The BARE name is a candidate on every
 * platform (`findGitHubToolPath` lists `.exe`/`.bat`/`.cmd` and then the bare
 * name on win32), so one fixture covers both lanes without a platform skip.
 */
function writeManagedBinary(): string {
	const binPath = path.join(tmpHome, "bin", "actionlint");
	fs.mkdirSync(path.dirname(binPath), { recursive: true });
	fs.writeFileSync(binPath, "#!/bin/sh\nexit 0\n");
	fs.chmodSync(binPath, 0o755);
	return binPath;
}

/** The checker exactly as `clients/dispatch/runners/actionlint.ts` builds it. */
async function actionlintChecker() {
	const helpers =
		await import("../../../../clients/dispatch/runners/utils/runner-helpers.js");
	helpers.resetDispatchAvailabilityState();
	return helpers.createAvailabilityChecker("actionlint", ".exe");
}

async function spawnMock() {
	const mod = await import("../../../../clients/safe-spawn.js");
	return vi.mocked(mod.safeSpawnAsync);
}

beforeEach(() => {
	vi.resetModules();
	logLatencySpy.mockReset();
	tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2140-home-"));
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2140-cwd-"));
	piLensDirHolder.dir = tmpHome;
});

afterEach(() => {
	removeTempDirSync(tmpHome);
	removeTempDirSync(cwd);
});

describe("availability probe: pi-lens's own managed bin dir (#2140)", () => {
	it("reports a managed-dir-only tool available, in ONE decision row", async () => {
		const managed = writeManagedBinary();
		(await spawnMock()).mockImplementation(async (command: string) =>
			command === managed ? (versionOk() as never) : (enoent() as never),
		);

		const checker = await actionlintChecker();

		expect(await checker.isAvailableAsync(cwd)).toBe(true);
		expect(checker.getCommand(cwd)).toBe(managed);
		// Pre-fix this was two rows: a latched `unavailable` from the PATH-only
		// probe, then the install fallback's compensating `available`.
		expect(decisions()).toHaveLength(1);
		expect(decisions()[0].metadata).toMatchObject({
			tool: "actionlint",
			verdict: "available",
			outcome: "success",
			// Which directory answered, in the record a log reader already reads:
			// `source` present IS the managed-dir hit, absent is PATH/venv.
			evidence: { binary: "actionlint", source: "github-release" },
		});
	});

	it("keeps a tool that is in neither PATH nor the managed dir unavailable", async () => {
		(await spawnMock()).mockResolvedValue(enoent() as never);

		const checker = await actionlintChecker();

		expect(await checker.isAvailableAsync(cwd)).toBe(false);
		expect(decisions()).toHaveLength(1);
		expect(decisions()[0].metadata).toMatchObject({
			tool: "actionlint",
			verdict: "unavailable",
			outcome: "missing",
			cause: "not-found",
			latched: true,
		});
		// The negative case must stay negative: no managed path is invented for
		// a tool whose directory entry does not exist.
		expect(decisions()[0].metadata.evidence.source).toBeUndefined();
	});

	it("falls through to PATH when the managed binary cannot run (#1657)", async () => {
		const managed = writeManagedBinary();
		(await spawnMock()).mockImplementation(async (command: string) =>
			// The managed file exists but rejects its own `--version`; PATH has a
			// working one. An on-disk binary must never shadow it.
			command === managed
				? ({ stdout: "", stderr: "", status: 1 } as never)
				: (versionOk() as never),
		);

		const checker = await actionlintChecker();

		expect(await checker.isAvailableAsync(cwd)).toBe(true);
		expect(checker.getCommand(cwd)).toBe("actionlint");
		expect(decisions()[0].metadata.evidence.source).toBeUndefined();
	});
});
