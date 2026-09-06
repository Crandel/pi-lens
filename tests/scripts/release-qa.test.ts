/**
 * #2606 — the release-QA runner's pure core.
 *
 * The runner's value is entirely in its bookkeeping: which rows exist, what
 * outcome each one earned, and whether the arithmetic adds up. #2587 is the
 * recurrence it guards — four shipped skills that nothing ever asked a real pi
 * about, invisible because coverage was claimed rather than counted.
 *
 * These cases hold the decisions that can turn a run dishonest:
 *   - a polled row whose cap expired reads UNTESTED, never PASS;
 *   - a row with no probe reads UNTESTED, so it is arithmetic rather than
 *     silence;
 *   - a run where pi could not boot reads BLOCKED with NO ship verdict;
 *   - the four outcomes must partition the DISCOVERED set, not merely each
 *     other, so a row that fell out of the loop is an ARITHMETIC MISMATCH;
 *   - the matrix document and the runner's probe map are one list, not two.
 *
 * Deliberately NOT here: anything that spawns a real pi. That is the runner's
 * own job and install-smoke's lane; a unit test that installs a coding agent is
 * a nightly wearing a per-PR badge.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	BASELINE_COLUMNS,
	classifyProbe,
	coverageArithmetic,
	formatOutcome,
	implementedRowIds,
	parseArgs,
	parseBaselineRows,
	pollToTerminal,
	renderCoverageLine,
	renderReport,
	shipVerdict,
	verdictExitCode,
} from "../../scripts/release-qa.mjs";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const BASELINE_PATH = path.join(REPO_ROOT, "docs", "release-qa-baseline.md");

function baselineText(): string {
	return fs.readFileSync(BASELINE_PATH, "utf8");
}

function row(id: string, outcome: string, detail = "", implemented = true) {
	return { id, outcome, detail, implemented };
}

describe("release-QA baseline matrix parsing (#2606)", () => {
	it("parses the committed baseline into at least eight fully-populated rows", () => {
		const { rows, errors } = parseBaselineRows(baselineText());
		expect(errors).toEqual([]);
		expect(rows.length).toBeGreaterThanOrEqual(8);
		for (const parsed of rows) {
			expect(parsed.id).not.toBe("");
			expect(parsed.feature).not.toBe("");
			expect(parsed.modality).not.toBe("");
			expect(parsed.entryPoint).not.toBe("");
			expect(parsed.passCriterion).not.toBe("");
			expect(parsed.witness).not.toBe("");
			expect(parsed.reuse).not.toBe("");
		}
	});

	it("covers at least three distinct modalities", () => {
		const { rows } = parseBaselineRows(baselineText());
		const modalities = new Set(rows.map((r) => r.modality));
		expect(modalities.size).toBeGreaterThanOrEqual(3);
	});

	it("reports a missing column instead of parsing a partial matrix", () => {
		const text = baselineText().replace("| pass criterion |", "| criterion |");
		const { rows, errors } = parseBaselineRows(text);
		expect(rows).toEqual([]);
		expect(errors.join("\n")).toContain('missing the "pass criterion" column');
	});

	it("reports a duplicate row id rather than silently collapsing two rows", () => {
		const { rows } = parseBaselineRows(baselineText());
		const duplicated = baselineText().replace(
			`| ${rows[1].id} |`,
			`| ${rows[0].id} |`,
		);
		const { errors } = parseBaselineRows(duplicated);
		expect(errors.join("\n")).toContain(`duplicate row id "${rows[0].id}"`);
	});

	it("reports a missing table rather than returning zero rows as success", () => {
		const { rows, errors } = parseBaselineRows("# no matrix here\n");
		expect(rows).toEqual([]);
		expect(errors.join("\n")).toContain("no matrix table found");
	});

	it("names every column the runner reads", () => {
		expect([...BASELINE_COLUMNS]).toEqual([
			"row id",
			"feature",
			"modality",
			"entry point",
			"pass criterion",
			"witness",
			"reuse",
		]);
	});
});

describe("release-QA matrix and probe map are one list (#2606)", () => {
	// The single-source-of-truth tie. A probe map that drifts from the matrix is
	// exactly the hand-maintained mirror AGENTS.md forbids: a row could be
	// dropped from the document and keep running invisibly, or gain a probe
	// nobody documented.
	it("has a probe for every baseline row and a baseline row for every probe", () => {
		const { rows } = parseBaselineRows(baselineText());
		const documented = rows.map((r) => r.id).sort();
		expect(implementedRowIds()).toEqual(documented);
	});
});

describe("release-QA outcome rules (#2606)", () => {
	it("classifies a passing probe as PASS", () => {
		expect(classifyProbe({ status: "pass", detail: "4 skills" })).toEqual({
			outcome: "PASS",
			detail: "4 skills",
		});
	});

	it("classifies a failing probe as FAIL carrying the observed cause", () => {
		expect(classifyProbe({ status: "fail", detail: "0 skills" })).toEqual({
			outcome: "FAIL",
			detail: "0 skills",
		});
	});

	it("classifies a thrown probe as FAIL, not as untested", () => {
		expect(classifyProbe({ status: "error", detail: "ENOENT" }).outcome).toBe(
			"FAIL",
		);
	});

	it("classifies an expired polling cap as UNTESTED, never PASS", () => {
		const classified = classifyProbe({
			status: "expired",
			detail: "cap 120000ms expired after 24 attempt(s)",
		});
		expect(classified.outcome).toBe("UNTESTED");
		expect(classified.detail).toContain("expired");
	});

	it("classifies an unreachable row as SKIPPED", () => {
		expect(
			classifyProbe({ status: "unreachable", detail: "no --git-ref" }).outcome,
		).toBe("SKIPPED");
	});

	it("classifies a row with no probe as UNTESTED with that reason", () => {
		expect(classifyProbe({ status: "unimplemented" })).toEqual({
			outcome: "UNTESTED",
			detail: "no runner implementation for this row",
		});
	});

	it("classifies a row skipped by a blocked run as UNTESTED with the block reason", () => {
		expect(
			classifyProbe({ status: "blocked", detail: "pi could not boot: timeout" }),
		).toEqual({
			outcome: "UNTESTED",
			detail: "pi could not boot: timeout",
		});
	});

	it("classifies an unrecognised status as UNTESTED rather than assuming success", () => {
		const classified = classifyProbe({ status: "probably-fine" });
		expect(classified.outcome).toBe("UNTESTED");
		expect(classified.detail).toContain("unknown probe status");
	});

	it("formats non-passing outcomes with their cause in parentheses", () => {
		expect(formatOutcome({ outcome: "PASS", detail: "ok" })).toBe("PASS");
		expect(formatOutcome({ outcome: "FAIL", detail: "0 skills" })).toBe(
			"FAIL(0 skills)",
		);
		expect(formatOutcome({ outcome: "SKIPPED", detail: "" })).toBe(
			"SKIPPED(no reason recorded)",
		);
	});
});

describe("release-QA polling (#2606)", () => {
	it("returns terminal as soon as the attempt reports one", async () => {
		let calls = 0;
		const polled = await pollToTerminal(
			async () => {
				calls++;
				return { terminal: calls >= 2, detail: `attempt ${calls}` };
			},
			{ capMs: 5000, intervalMs: 1 },
		);
		expect(polled.status).toBe("terminal");
		expect(polled.attempts).toBe(2);
	});

	it("expires with the last observed detail when the cap elapses first", async () => {
		const polled = await pollToTerminal(
			async () => ({ terminal: false, detail: "still scanning" }),
			{ capMs: 30, intervalMs: 1 },
		);
		expect(polled.status).toBe("expired");
		expect(polled.detail).toContain("still scanning");
		expect(classifyProbe({ status: polled.status, detail: polled.detail }).outcome).toBe(
			"UNTESTED",
		);
	});
});

describe("release-QA coverage arithmetic (#2606)", () => {
	it("counts each outcome and balances against the discovered row count", () => {
		const coverage = coverageArithmetic(
			[
				row("a", "PASS"),
				row("b", "FAIL", "0 skills"),
				row("c", "UNTESTED", "cap expired"),
				row("d", "SKIPPED", "no ref", false),
			],
			4,
		);
		expect(coverage).toMatchObject({
			discovered: 4,
			rows: 3,
			pass: 1,
			fail: 1,
			untested: 1,
			skipped: 1,
			balanced: true,
		});
	});

	it("reports an imbalance when a discovered row produced no result", () => {
		const coverage = coverageArithmetic([row("a", "PASS")], 3);
		expect(coverage.balanced).toBe(false);
		expect(renderCoverageLine(coverage)).toContain("ARITHMETIC MISMATCH");
	});

	it("prints the discovered / rows / untested arithmetic", () => {
		const coverage = coverageArithmetic(
			[row("a", "PASS"), row("b", "UNTESTED", "cap expired")],
			2,
		);
		expect(renderCoverageLine(coverage)).toBe(
			"coverage: discovered 2 / rows 2 / untested 1  " +
				"(pass 1 · fail 0 · untested 1 · skipped 0)",
		);
	});
});

describe("release-QA ship verdict (#2606)", () => {
	it("issues no ship verdict when pi could not boot", () => {
		const verdict = shipVerdict([row("a", "PASS")], {
			blocked: true,
			blockedReason: "pi exited early (code 1)",
		});
		expect(verdict.verdict).toBe("BLOCKED");
		expect(verdict.reason).toBe("pi exited early (code 1)");
		expect(verdictExitCode(verdict.verdict)).toBe(3);
	});

	it("says do not ship when any row FAILED", () => {
		const verdict = shipVerdict([
			row("a", "PASS"),
			row("b", "FAIL", "0 skills registered"),
		]);
		expect(verdict.verdict).toBe("DO-NOT-SHIP");
		expect(verdict.caveats).toEqual(["b: 0 skills registered"]);
		expect(verdictExitCode(verdict.verdict)).toBe(1);
	});

	it("prefers do-not-ship over caveats when both a FAIL and an UNTESTED exist", () => {
		const verdict = shipVerdict([
			row("a", "UNTESTED", "cap expired"),
			row("b", "FAIL", "0 skills"),
		]);
		expect(verdict.verdict).toBe("DO-NOT-SHIP");
	});

	it("ships with caveats, each named, when a row produced no witness", () => {
		const verdict = shipVerdict([
			row("a", "PASS"),
			row("b", "SKIPPED", "no --git-ref"),
		]);
		expect(verdict.verdict).toBe("SHIP-WITH-CAVEATS");
		expect(verdict.caveats).toEqual(["b SKIPPED(no --git-ref)"]);
		expect(verdictExitCode(verdict.verdict)).toBe(2);
	});

	it("ships only when every discovered row PASSED", () => {
		const verdict = shipVerdict([row("a", "PASS"), row("b", "PASS")]);
		expect(verdict.verdict).toBe("SHIP");
		expect(verdictExitCode(verdict.verdict)).toBe(0);
	});
});

describe("release-QA report rendering (#2606)", () => {
	it("carries each row's witness path and the excerpt that shows the result", () => {
		const rows = [
			{
				id: "skills-registered",
				feature: "f",
				modality: "pi-rpc",
				entryPoint: "e",
				passCriterion: "p",
				witness: "w",
				reuse: "r",
			},
		];
		const results = [
			{
				id: "skills-registered",
				outcome: "PASS",
				detail: "4 skill command(s)",
				implemented: true,
				witnessPath: "release-qa-evidence/skills-registered.json",
				shows: "4 skill command(s): skill:pi-lens-ast-grep",
			},
		];
		const report = renderReport({
			rows,
			results,
			coverage: coverageArithmetic(results, 1),
			verdict: shipVerdict(results),
			context: { pi: "pi 0.80.10" },
		});
		expect(report).toContain("## Verdict: SHIP");
		expect(report).toContain("release-qa-evidence/skills-registered.json");
		expect(report).toContain("4 skill command(s): skill:pi-lens-ast-grep");
		expect(report).toContain("coverage: discovered 1 / rows 1 / untested 0");
	});

	it("says plainly that a blocked run gets no ship verdict", () => {
		const report = renderReport({
			rows: [],
			results: [],
			coverage: coverageArithmetic([], 0),
			verdict: shipVerdict([], { blocked: true, blockedReason: "no pi" }),
		});
		expect(report).toContain("## Verdict: BLOCKED");
		expect(report).toContain("No ship verdict is issued for a blocked run");
	});
});

describe("release-QA argument parsing (#2606)", () => {
	it("defaults to the committed baseline and a stated polling cap", () => {
		const opts = parseArgs([]);
		expect(opts.from).toBe("tree");
		expect(opts.pollCapMs).toBeGreaterThan(0);
		expect(opts.baseline.replaceAll("\\", "/")).toContain(
			"docs/release-qa-baseline.md",
		);
	});

	it("rejects an unknown option instead of ignoring it", () => {
		expect(() => parseArgs(["--wat"])).toThrow(/unknown option: --wat/);
	});
});
