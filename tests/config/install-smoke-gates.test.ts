// Pins install-smoke.yml's FOUR job-level `if:` event gates (#2613 review
// T1): the three `!= 'pull_request'` gates on `smoke`/`pi-load`/`mise-repro`
// (unchanged pre-#2613 behavior -- the os x pm x pi-install matrices stay
// off pull_request) and `host-latest-smoke`'s `schedule`/`workflow_dispatch`
// gate (the nightly advisory lane). `host-range-smoke` deliberately carries
// NO gate (it is the new PR-gating lane) and is intentionally absent from
// this table.
//
// Same technique as tests/config/ci-infra-kill-rerun-gate.test.ts (#2668
// review F3): load the REAL workflow via yaml.load, then evaluate the
// LOADED `if:` string (never a hand-copied restatement of it) against a
// synthetic `github.event_name` via `new Function` — GitHub Actions
// expression syntax and JS agree exactly on this subset (dotted paths, `==`,
// `!=`, `&&`, `||`, quoted string literals).
//
// Before this file existed, dropping all three `!= 'pull_request'` gates
// AND the schedule gate stayed 27/27 green (no test in the repo evaluated
// any of these `if:` strings) — proven below by deleting one gate.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const WORKFLOW_PATH = ".github/workflows/install-smoke.yml";

type Job = { if?: unknown };
type Workflow = { jobs?: Record<string, Job> };

function loadWorkflow(source?: string): Workflow {
	const text =
		source ?? readFileSync(resolve(REPO_ROOT, WORKFLOW_PATH), "utf8");
	return yaml.load(text) as Workflow;
}

function readJobIf(workflow: Workflow, jobName: string): string {
	const ifExpr = workflow.jobs?.[jobName]?.if;
	if (typeof ifExpr !== "string") {
		throw new Error(
			`${WORKFLOW_PATH}: jobs.${jobName}.if is not a string (got ${typeof ifExpr})`,
		);
	}
	return ifExpr;
}

function evaluateIf(expr: string, eventName: string): boolean {
	const substituted = expr
		.split("github.event_name")
		.join(JSON.stringify(eventName));
	if (substituted.includes("github.")) {
		throw new Error(
			`unsubstituted github.* reference survived evaluation: ${substituted} (this table only understands github.event_name)`,
		);
	}
	// `new Function` on a string built entirely from this repo's own workflow
	// file plus a JSON-literal test fixture, never external/untrusted input.
	const fn = new Function(`"use strict"; return (${substituted});`);
	return Boolean(fn());
}

const EVENTS = [
	"pull_request",
	"push",
	"schedule",
	"workflow_dispatch",
	"repository_dispatch",
] as const;

// [jobName, expected-eligible-events]
const GATES: Array<[string, readonly string[]]> = [
	["smoke", ["push", "schedule", "workflow_dispatch", "repository_dispatch"]],
	["pi-load", ["push", "schedule", "workflow_dispatch", "repository_dispatch"]],
	[
		"mise-repro",
		["push", "schedule", "workflow_dispatch", "repository_dispatch"],
	],
	["host-latest-smoke", ["schedule", "workflow_dispatch"]],
];

describe("install-smoke.yml job event gates (#2613 review T1)", () => {
	const workflow = loadWorkflow();

	it("names exactly the four gated jobs this table covers", () => {
		// Guards the table itself: a job renamed out from under GATES would
		// otherwise throw inside readJobIf below with a less legible message.
		expect(GATES.map(([name]) => name).sort()).toEqual(
			["mise-repro", "pi-load", "smoke", "host-latest-smoke"].sort(),
		);
	});

	it("host-range-smoke deliberately carries no event gate (always eligible, incl. pull_request)", () => {
		expect(workflow.jobs?.["host-range-smoke"]?.if).toBeUndefined();
	});

	for (const [jobName, eligibleEvents] of GATES) {
		describe(`jobs.${jobName}.if`, () => {
			const ifExpr = readJobIf(workflow, jobName);

			for (const event of EVENTS) {
				const expected = eligibleEvents.includes(event);
				it(`${expected ? "runs" : "skips"} on ${event}`, () => {
					expect(evaluateIf(ifExpr, event)).toBe(expected);
				});
			}
		});
	}

	// Mutation-proof: before this file existed, no test evaluated these `if:`
	// strings at all, so deleting a gate was invisible (27/27 stayed green).
	// Demonstrate the table catches it for each of the four gates.
	for (const [jobName] of GATES) {
		it(`mutation-proof: deleting jobs.${jobName}.if reds this table (job becomes unconditionally eligible)`, () => {
			const source = readFileSync(resolve(REPO_ROOT, WORKFLOW_PATH), "utf8");
			const lines = source.split("\n");
			// Locate THIS job's own top-level key line ("  <jobName>:", exactly
			// two leading spaces so a same-named step/matrix key nested deeper
			// never matches), then remove the first "if:" line found before the
			// next top-level job key -- several of these jobs share the exact
			// same `if:` text, so a plain string .replace() would always hit
			// the FIRST job carrying that text regardless of which job this
			// iteration targets (caught by this test itself: with a naive
			// global replace, the pi-load/mise-repro cases redded against the
			// WRONG job -- smoke's -- having already lost its gate).
			const jobKeyPattern = new RegExp(`^ {2}${jobName}:\\s*$`);
			const startIdx = lines.findIndex((line) => jobKeyPattern.test(line));
			expect(
				startIdx,
				`job key line for ${jobName} not found`,
			).toBeGreaterThanOrEqual(0);
			let ifLineIdx = -1;
			for (let i = startIdx + 1; i < lines.length; i++) {
				if (/^ {2}\S.*:\s*$/.test(lines[i])) break; // next top-level job key
				if (/^\s*if:\s/.test(lines[i])) {
					ifLineIdx = i;
					break;
				}
			}
			expect(
				ifLineIdx,
				`no if: line found under jobs.${jobName}`,
			).toBeGreaterThanOrEqual(0);

			const mutatedLines = [...lines];
			mutatedLines.splice(ifLineIdx, 1);
			const mutatedSource = mutatedLines.join("\n");
			expect(mutatedSource).not.toBe(source);

			const mutatedWorkflow = loadWorkflow(mutatedSource);
			// With the gate gone, the job has no `if:` at all -- readJobIf would
			// throw ("not a string"), which itself IS the red signal a real
			// silent-drop would produce against this table's other assertions.
			expect(mutatedWorkflow.jobs?.[jobName]?.if).toBeUndefined();
		});
	}
});
