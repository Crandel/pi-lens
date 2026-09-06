/**
 * #2638 review: the tool-smoke lane's `ensureTool` failure classification.
 *
 * The nightly saw `ensureTool(vscode-css-languageserver) → UNAVAILABLE` every
 * night — a real installer defect (the package was unpublished, npm E404) —
 * but `scripts/smoke-tools.mjs` folded that into the same "unavailable" (⚠
 * skip) bucket a genuinely-absent toolchain (no Rust for rust-analyzer, no Go
 * for gopls) uses, and the only gate is the aggregate pass floor, which one
 * dead server never breaches. `isGenuineInstallFailure`/`genuineInstallFailure`
 * are the pure decision this issue's review demanded: an npm-strategy tool
 * can never fail because Node is absent (this harness itself runs under
 * Node), so its `ensureTool` failure is ALWAYS a real defect; a pip/gem tool's
 * failure is genuine only when that runtime was actually present.
 *
 * Pure functions, no process spawn, no LSP handshake — the live end-to-end
 * proof (a real `ensureTool("vscode-css-languageserver")` failing pre-fix,
 * then succeeding post-fix, through the real `--lsp css --install` CLI) is
 * quoted in the PR body rather than re-run here as a flake-prone e2e test.
 */
import { describe, expect, it } from "vitest";
import {
	genuineInstallFailure,
	isGenuineInstallFailure,
} from "../../scripts/smoke-tools.mjs";

describe("isGenuineInstallFailure (#2638)", () => {
	it("an npm-strategy failure is always genuine — this harness itself needs Node", () => {
		expect(isGenuineInstallFailure("npm", undefined)).toBe(true);
		expect(isGenuineInstallFailure("npm", false)).toBe(true);
	});

	it("a pip/gem failure is genuine only when its toolchain was present", () => {
		expect(isGenuineInstallFailure("pip", true)).toBe(true);
		expect(isGenuineInstallFailure("pip", false)).toBe(false);
		expect(isGenuineInstallFailure("gem", true)).toBe(true);
		expect(isGenuineInstallFailure("gem", false)).toBe(false);
	});

	it("every other strategy keeps the existing toolchain-absent skip (github/maven/archive)", () => {
		expect(isGenuineInstallFailure("github", true)).toBe(false);
		expect(isGenuineInstallFailure("maven", true)).toBe(false);
		expect(isGenuineInstallFailure("archive", true)).toBe(false);
	});
});

describe("genuineInstallFailure (#2638)", () => {
	const toolsById = new Map([
		["vscode-css-languageserver", { installStrategy: "npm" }],
		["rust-analyzer", { installStrategy: "github" }],
		["jedi-language-server", { installStrategy: "pip" }],
	]);

	it("names the npm tool and its real reason — the exact #2638 shape", () => {
		const unavailable = new Set(["vscode-css-languageserver"]);
		const reasons = new Map([
			[
				"vscode-css-languageserver",
				"npm ERR! code ENOVERSIONS\nnpm ERR! No versions available",
			],
		]);
		const result = genuineInstallFailure(
			["vscode-css-languageserver"],
			unavailable,
			toolsById,
			reasons,
			{},
		);
		expect(result).toMatchObject({
			toolId: "vscode-css-languageserver",
			strategy: "npm",
			reason: expect.stringContaining("ENOVERSIONS"),
		});
	});

	it("returns undefined when the unavailable tool's strategy is a real toolchain gap (github)", () => {
		const unavailable = new Set(["rust-analyzer"]);
		const result = genuineInstallFailure(
			["rust-analyzer"],
			unavailable,
			toolsById,
			new Map(),
			{},
		);
		expect(result).toBeUndefined();
	});

	it("returns undefined when no tool in the list is unavailable at all", () => {
		const result = genuineInstallFailure(
			["vscode-css-languageserver"],
			new Set(),
			toolsById,
			new Map(),
			{},
		);
		expect(result).toBeUndefined();
	});

	it("uses the precomputed toolchain-presence cache for pip/gem rather than re-probing", () => {
		const unavailable = new Set(["jedi-language-server"]);
		const cache = { pip: true };
		const result = genuineInstallFailure(
			["jedi-language-server"],
			unavailable,
			toolsById,
			new Map([["jedi-language-server", "pip install failed"]]),
			cache,
		);
		expect(result?.toolId).toBe("jedi-language-server");
		// The cache is reused as-is (not overwritten with a fresh probe result).
		expect(cache.pip).toBe(true);
	});

	it("a pip tool's failure is NOT genuine when the cache says the toolchain was absent", () => {
		const unavailable = new Set(["jedi-language-server"]);
		const cache = { pip: false };
		const result = genuineInstallFailure(
			["jedi-language-server"],
			unavailable,
			toolsById,
			new Map([["jedi-language-server", "pip install failed"]]),
			cache,
		);
		expect(result).toBeUndefined();
	});
});
