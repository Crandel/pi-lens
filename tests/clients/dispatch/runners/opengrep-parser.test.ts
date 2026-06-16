import { describe, expect, it } from "vitest";
import type { DispatchContext } from "../../../../clients/dispatch/types.js";
import { parseOpengrepJson } from "../../../../clients/dispatch/runners/opengrep.js";

const ctx = { filePath: "fallback.ts" } as unknown as DispatchContext;

function jsonOf(results: unknown[]): string {
	return JSON.stringify({ results });
}

describe("parseOpengrepJson", () => {
	it("returns [] for empty or invalid input", () => {
		expect(parseOpengrepJson("", ctx)).toEqual([]);
		expect(parseOpengrepJson("   ", ctx)).toEqual([]);
		expect(parseOpengrepJson("{not json", ctx)).toEqual([]);
		expect(parseOpengrepJson(jsonOf([]), ctx)).toEqual([]);
	});

	it("maps an explicit pi-lens blocking rule to error/blocking", () => {
		const raw = jsonOf([
			{
				check_id: "rules.no-eval",
				path: "src/a.ts",
				start: { line: 10, col: 3 },
				extra: {
					message: "Avoid eval",
					severity: "ERROR",
					metadata: {
						"pi-lens": { semantic: "blocking", defect_class: "injection" },
					},
					fix: "use a parser",
				},
			},
		]);
		const [d] = parseOpengrepJson(raw, ctx);
		expect(d.tool).toBe("opengrep");
		expect(d.id.startsWith("opengrep:")).toBe(true);
		expect(d.severity).toBe("error");
		expect(d.semantic).toBe("blocking");
		expect(d.defectClass).toBe("injection");
		expect(d.line).toBe(10);
		expect(d.column).toBe(3);
		expect(d.filePath).toBe("src/a.ts");
		expect(d.fixable).toBe(true);
		expect(d.fixKind).toBe("suggestion");
		expect(d.fixSuggestion).toBe("use a parser");
	});

	it("promotes a high-signal security ERROR to blocking without explicit semantic", () => {
		const raw = jsonOf([
			{
				check_id: "rules.ssrf",
				path: "src/b.ts",
				start: { line: 1, col: 1 },
				extra: {
					message: "Possible SSRF",
					severity: "ERROR",
					metadata: { "pi-lens": { defect_class: "safety" }, confidence: "high" },
				},
			},
		]);
		const [d] = parseOpengrepJson(raw, ctx);
		expect(d.semantic).toBe("blocking");
		expect(d.severity).toBe("error");
	});

	it("keeps low-confidence security findings as warnings", () => {
		const raw = jsonOf([
			{
				check_id: "rules.maybe",
				path: "src/c.ts",
				start: { line: 2, col: 1 },
				extra: {
					message: "Maybe unsafe",
					severity: "ERROR",
					metadata: { "pi-lens": { defect_class: "safety" }, confidence: "low" },
				},
			},
		]);
		const [d] = parseOpengrepJson(raw, ctx);
		expect(d.semantic).toBe("warning");
	});

	it("falls back to ctx.filePath when a result omits its path", () => {
		const raw = jsonOf([
			{ check_id: "r", start: { line: 1, col: 1 }, extra: { message: "m" } },
		]);
		const [d] = parseOpengrepJson(raw, ctx);
		expect(d.filePath).toBe("fallback.ts");
	});

	it("caps output at MAX_DIAGNOSTICS (50)", () => {
		const results = Array.from({ length: 60 }, (_, i) => ({
			check_id: `r${i}`,
			path: "x.ts",
			start: { line: i + 1, col: 1 },
			extra: { message: "m", severity: "WARNING" },
		}));
		expect(parseOpengrepJson(jsonOf(results), ctx)).toHaveLength(50);
	});
});
