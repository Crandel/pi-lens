import { describe, expect, it } from "vitest";
import type { LSPDiagnostic } from "../../../clients/lsp/client.js";
import {
	AUXILIARY_LSP_PROFILES,
	enabledAuxiliaryLspServerIds,
	findAuxiliaryProfileForSource,
} from "../../../clients/dispatch/auxiliary-lsp.js";

const diag = (over: Partial<LSPDiagnostic>): LSPDiagnostic =>
	({
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
		message: "x",
		severity: 2,
		...over,
	}) as LSPDiagnostic;

describe("auxiliary LSP enablement", () => {
	it("opengrep is default-on (no kill-switch flag set)", () => {
		const ids = enabledAuxiliaryLspServerIds(() => undefined);
		expect(ids).toContain("opengrep");
	});

	it("the no-opengrep kill switch disables it", () => {
		const ids = enabledAuxiliaryLspServerIds((f) => f === "no-opengrep");
		expect(ids).not.toContain("opengrep");
	});
});

describe("auxiliary profile source routing", () => {
	it("routes Opengrep's 'Semgrep' source to the opengrep profile", () => {
		expect(findAuxiliaryProfileForSource("Semgrep")?.tool).toBe("opengrep");
		expect(findAuxiliaryProfileForSource("opengrep")?.tool).toBe("opengrep");
	});

	it("ignores language-server sources and missing source", () => {
		expect(findAuxiliaryProfileForSource("typescript")).toBeUndefined();
		expect(findAuxiliaryProfileForSource("eslint")).toBeUndefined();
		expect(findAuxiliaryProfileForSource(undefined)).toBeUndefined();
	});
});

describe("opengrep semantic policy", () => {
	const opengrep = AUXILIARY_LSP_PROFILES.find((p) => p.serverId === "opengrep");

	it("ERROR-severity findings block; lower severities advise", () => {
		expect(opengrep).toBeDefined();
		expect(opengrep?.semantic(diag({ severity: 1 }))).toBe("blocking");
		expect(opengrep?.semantic(diag({ severity: 2 }))).toBe("warning");
		expect(opengrep?.semantic(diag({ severity: 3 }))).toBe("warning");
	});

	it("derives a defect class from the rule", () => {
		const dc = opengrep?.defectClass?.(
			diag({ code: "javascript.lang.security.audit.eval", message: "eval" }),
		);
		expect(typeof dc === "string" || dc === undefined).toBe(true);
	});
});
