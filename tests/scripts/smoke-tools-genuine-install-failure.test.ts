/**
 * #2638/#2661 review: the tool-smoke lane's `ensureTool` failure classification.
 *
 * Round 1 shipped `genuineInstallFailure`, which inferred "genuine" from
 * install strategy + the `getInstallFailureReason` REFUSAL map alone — the
 * exact inference `clients/installer/index.ts`'s own `InstallAttempt` doc
 * comment says cannot answer "did an install even run" (#1500 round 3 deleted
 * this same inference from `describeInstallAttempt` for the identical
 * reason). Review F1 reproduced it directly: `PI_LENS_DISABLE_TOOL_INSTALL=1`
 * (outcome `declined`), an install-lock timeout (`skipped`), and a
 * project-trust decline (`declined`) all left `unavailableTools` populated
 * with NO install ever having run, and the old function reported every one
 * of them as a genuine npm-strategy failure — a false RED on a lane the
 * operator deliberately disabled installs on.
 *
 * `classifyInstallOutcome` fixes this by gating on
 * `getInstallAttempt(toolId)?.outcome === "failed"` FIRST — the only outcome
 * that means "an install genuinely ran and did not succeed" — before ever
 * consulting strategy/toolchain. It also excludes a transient/offline
 * registry condition (F2: `ENOTFOUND`/`E5xx` is a runner condition, not an
 * installer defect) and caps the reported detail to one line (F5).
 *
 * `resolveUnavailabilityRow` is the single wrapper all three
 * `runLspHandshake` unavailability sites now call (F3 — collapses three
 * near-identical inline blocks into one, tested once here).
 */
import { describe, expect, it } from "vitest";
import {
	classifyInstallOutcome,
	resolveUnavailabilityRow,
} from "../../scripts/smoke-tools.mjs";

interface SmokeInstallAttempt {
	outcome: "succeeded" | "failed" | "declined" | "skipped";
	reason?: string;
}
type GetInstallAttempt = (toolId: string) => SmokeInstallAttempt | undefined;

const toolsById = new Map([
	["vscode-css-languageserver", { installStrategy: "npm" }],
	["rust-analyzer", { installStrategy: "github" }],
	["jedi-language-server", { installStrategy: "pip" }],
	["some-gem-tool", { installStrategy: "gem" }],
]);

function deps(
	getInstallAttempt: GetInstallAttempt,
	overrides: Record<string, unknown> = {},
) {
	return {
		getInstallAttempt,
		toolsById,
		toolchainPresence: {},
		pipCandidates: ["pip3", "pip", "python3", "python"],
		...overrides,
	};
}

describe("classifyInstallOutcome (#2638/#2661 F1)", () => {
	it("a genuine npm failure (outcome: failed) is a fail row with the real reason", () => {
		const result = classifyInstallOutcome(
			"vscode-css-languageserver",
			deps(() => ({
				outcome: "failed",
				reason: "npm ERR! code ENOVERSIONS\nnpm ERR! No versions available",
			})),
		);
		expect(result.row).toBe("fail");
		expect(result.detail).toContain("vscode-css-languageserver");
		expect(result.detail).toContain("ENOVERSIONS");
	});

	// The exact three reviewer probes, reproduced directly.
	it("PI_LENS_DISABLE_TOOL_INSTALL=1 (outcome: declined) is a skip, never a fail", () => {
		const result = classifyInstallOutcome(
			"vscode-css-languageserver",
			deps(() => ({
				outcome: "declined",
				reason: "installation disabled by PI_LENS_DISABLE_TOOL_INSTALL=1",
			})),
		);
		expect(result.row).toBe("skip");
	});

	it("an install-lock timeout (outcome: skipped) is a skip, never a fail", () => {
		const result = classifyInstallOutcome(
			"vscode-css-languageserver",
			deps(() => ({ outcome: "skipped", reason: "install lock held" })),
		);
		expect(result.row).toBe("skip");
	});

	it("a project-trust decline (outcome: declined) is a skip, never a fail", () => {
		const result = classifyInstallOutcome(
			"vscode-css-languageserver",
			deps(() => ({
				outcome: "declined",
				reason: "project trust: untrusted project",
			})),
		);
		expect(result.row).toBe("skip");
	});

	it("no attempt record at all is a skip", () => {
		const result = classifyInstallOutcome(
			"vscode-css-languageserver",
			deps(() => undefined),
		);
		expect(result.row).toBe("skip");
		expect(result.detail).toContain("no install attempt");
	});

	// F2: transient/offline registry conditions.
	it("a transient network failure (ENOTFOUND) is a skip, not a fail", () => {
		const result = classifyInstallOutcome(
			"vscode-css-languageserver",
			deps(() => ({
				outcome: "failed",
				reason: "npm error ENOTFOUND registry.npmjs.org",
			})),
		);
		expect(result.row).toBe("skip");
		expect(result.detail).toContain("transient");
	});

	it("a registry 5xx is a skip, not a fail", () => {
		const result = classifyInstallOutcome(
			"vscode-css-languageserver",
			deps(() => ({
				outcome: "failed",
				reason: "npm error E503 Service Unavailable",
			})),
		);
		expect(result.row).toBe("skip");
	});

	it("ETIMEDOUT/ECONNRESET/EAI_AGAIN are all treated as transient", () => {
		for (const errno of ["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN"]) {
			const result = classifyInstallOutcome(
				"vscode-css-languageserver",
				deps(() => ({ outcome: "failed", reason: `npm error ${errno}` })),
			);
			expect(result.row, errno).toBe("skip");
		}
	});

	// Strategy/toolchain gate, after the outcome gate.
	it("a genuine github-strategy failure stays a skip (toolchain-asset gap, unchanged)", () => {
		const result = classifyInstallOutcome(
			"rust-analyzer",
			deps(() => ({ outcome: "failed", reason: "no asset for this platform" })),
		);
		expect(result.row).toBe("skip");
	});

	it("a genuine pip failure with the toolchain present is a fail", () => {
		const result = classifyInstallOutcome(
			"jedi-language-server",
			deps(() => ({ outcome: "failed", reason: "pip install failed" }), {
				toolchainPresence: { pip: true },
			}),
		);
		expect(result.row).toBe("fail");
	});

	it("a genuine pip failure with the toolchain absent is a skip", () => {
		const result = classifyInstallOutcome(
			"jedi-language-server",
			deps(() => ({ outcome: "failed", reason: "pip install failed" }), {
				toolchainPresence: { pip: false },
			}),
		);
		expect(result.row).toBe("skip");
	});

	it("a genuine gem failure with the toolchain present is a fail", () => {
		const result = classifyInstallOutcome(
			"some-gem-tool",
			deps(() => ({ outcome: "failed", reason: "gem install failed" }), {
				toolchainPresence: { gem: true },
			}),
		);
		expect(result.row).toBe("fail");
	});

	// F5: detail is one line, capped.
	it("caps a multi-line reason to its first non-empty line, at 200 chars", () => {
		const longLine = "x".repeat(250);
		const result = classifyInstallOutcome(
			"vscode-css-languageserver",
			deps(() => ({
				outcome: "failed",
				reason: `\n\n${longLine}\nsecond line never shown`,
			})),
		);
		expect(result.row).toBe("fail");
		expect(result.detail).not.toContain("second line never shown");
		expect(result.detail.length).toBeLessThan(300);
	});
});

describe("resolveUnavailabilityRow (#2661 F3)", () => {
	it("returns the first genuine failure among several tool ids", () => {
		const attempts = new Map<string, SmokeInstallAttempt>([
			["rust-analyzer", { outcome: "declined" }],
			[
				"vscode-css-languageserver",
				{ outcome: "failed", reason: "npm ERR! code ENOVERSIONS" },
			],
		]);
		const result = resolveUnavailabilityRow(
			["rust-analyzer", "vscode-css-languageserver"],
			new Set(["rust-analyzer", "vscode-css-languageserver"]),
			deps((id: string) => attempts.get(id)),
			"fallback skip detail",
		);
		expect(result.row).toBe("fail");
		expect(result.detail).toContain("vscode-css-languageserver");
	});

	it("falls back to the given skip detail when nothing is genuine", () => {
		const attempts = new Map<string, SmokeInstallAttempt>([
			["rust-analyzer", { outcome: "declined" }],
		]);
		const result = resolveUnavailabilityRow(
			["rust-analyzer"],
			new Set(["rust-analyzer"]),
			deps((id: string) => attempts.get(id)),
			"fallback skip detail",
		);
		expect(result).toEqual({ row: "skip", detail: "fallback skip detail" });
	});

	it("skips tool ids that were never unavailable", () => {
		const result = resolveUnavailabilityRow(
			["vscode-css-languageserver"],
			new Set(),
			deps(() => ({ outcome: "failed", reason: "should not be reached" })),
			"fallback skip detail",
		);
		expect(result).toEqual({ row: "skip", detail: "fallback skip detail" });
	});
});
