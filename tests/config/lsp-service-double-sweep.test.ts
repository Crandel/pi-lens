/**
 * #2582 — hand-rolled `LSPService` doubles: a semantic sweep plus a two-sided
 * ratchet.
 *
 * The recurrence this guards: a test stubs `getLSPService` with a partial,
 * hand-rolled object, production later calls a method that object does not
 * have, and the failure lands in a swallow-all catch. It has cost three
 * rounds already — #1766 F3 (`isSpawnInFlight`), #2540/#2582 F3
 * (`getAuxiliaryClientsForFile`), and the CI red on this very branch's first
 * head (`tests/clients/lsp-lazy-liveness.test.ts:88`). `makeLspServiceDouble`
 * gives every such test the full surface with focused overrides; this sweep
 * keeps the hand-rolled population from growing back.
 *
 * ## Why a ratchet and not a clean gate
 *
 * 19 hand-rolled doubles in 18 files survive today, on seams this issue did
 * not scope (`tests/tools/lsp-*`, `tests/clients/mcp/*`,
 * `tests/clients/actionable-warnings*`, `dispatch/runners/pyright-*`). They
 * are pinned in `tests/support/lsp-double-baseline.json` and tracked to burn
 * down in #{FOLLOWUP}. The ratchet is TWO-SIDED, the same idiom as
 * `tests/clients/flake-shape-ratchet.test.ts` and `sweep-kit`'s
 * `auditRegistry`:
 *
 *   - a file the baseline does not name, flagged by the scan, FAILS — that is
 *     the acceptance criterion, "reds on a fresh hand-rolled service double
 *     outside the factory";
 *   - a pinned file whose count RISES fails;
 *   - a pinned file whose count FALLS fails too, as a stale ceiling: left
 *     pinned at 5 with 2 live, a file can regrow three doubles without ever
 *     tripping the rise check. Fix a fall by editing the pin down.
 *   - a pinned file the scan no longer flags AT ALL fails, as dead weight.
 *
 * ## Why the detector is structural
 *
 * Round 1 of this sweep was the literal string `touchFile: vi.fn(`, and it
 * shipped with 28 `const makeTouchFileMock = vi.fn;` call sites in
 * `cascade-compute.test.ts` whose only purpose was to rename the literal out
 * of its own reach. `tests/support/lsp-double-gate.ts` replaces it with an
 * AST walk from the `getLSPService` seam; the five shapes that defeated the
 * regex are pinned below as REAL FIXTURE FILES under
 * `tests/fixtures/lsp-double-gate/`, read and parsed through the same path as
 * the population walk — a string concatenated inside this file would only
 * prove the sweep agrees with itself.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
	findHandRolledLspDoubles,
	type HandRolledDouble,
	lspServiceMethodNames,
	repoRoot,
} from "../support/lsp-double-gate.js";
import {
	assertNonEmptyScan,
	listSourceFiles,
	relativePosix,
} from "../support/sweep-kit.js";

const TESTS_ROOT = path.join(repoRoot, "tests");
const FIXTURES = path.join(TESTS_ROOT, "fixtures/lsp-double-gate");

/** The factory and its analyser are the sweep's own machinery, not its subjects. */
const NOT_SUBJECTS = new Set([
	"tests/support/lsp-service-double.ts",
	"tests/support/lsp-double-gate.ts",
]);

type Baseline = Record<string, number>;

const BASELINE: Baseline = JSON.parse(
	fs.readFileSync(
		path.join(repoRoot, "tests/support/lsp-double-baseline.json"),
		"utf8",
	),
);

/** `file → hand-rolled double count` for every test source outside the fixtures. */
async function liveCounts(): Promise<Record<string, number>> {
	const files = listSourceFiles(TESTS_ROOT, {
		extensions: [".ts"],
		exclude: (rel) => rel.startsWith("fixtures/"),
	});
	assertNonEmptyScan("#2582 LSP service-double test walk", files.length, 200);
	const counts: Record<string, number> = {};
	for (const file of files) {
		const rel = relativePosix(repoRoot, file);
		if (NOT_SUBJECTS.has(rel)) continue;
		const hits = await findHandRolledLspDoubles(fs.readFileSync(file, "utf8"));
		if (hits.length > 0) counts[rel] = hits.length;
	}
	return counts;
}

interface RatchetProblem {
	file: string;
	kind: "new-file" | "count-risen" | "stale-ceiling" | "vanished";
	before?: number;
	after?: number;
}

function auditAgainstBaseline(
	live: Readonly<Record<string, number>>,
	baseline: Readonly<Baseline> = BASELINE,
): RatchetProblem[] {
	const problems: RatchetProblem[] = [];
	for (const [file, after] of Object.entries(live)) {
		const before = baseline[file];
		if (before === undefined) problems.push({ file, kind: "new-file", after });
		else if (after > before)
			problems.push({ file, kind: "count-risen", before, after });
		else if (after < before)
			problems.push({ file, kind: "stale-ceiling", before, after });
	}
	for (const file of Object.keys(baseline)) {
		if (!(file in live))
			problems.push({ file, kind: "vanished", before: baseline[file] });
	}
	return problems.sort((a, b) => a.file.localeCompare(b.file));
}

function describeProblem(p: RatchetProblem): string {
	switch (p.kind) {
		case "new-file":
			return (
				`${p.file}: ${p.after} hand-rolled LSPService double(s) in a file the ` +
				"baseline has never seen — seed it from makeLspServiceDouble() " +
				"(tests/support/lsp-service-double.ts) instead of writing the object " +
				"by hand; a partial double is how #1766 F3 and #2582 F3 both shipped"
			);
		case "count-risen":
			return `${p.file}: rose from ${p.before} to ${p.after} hand-rolled double(s) — migrate the new one to makeLspServiceDouble()`;
		case "stale-ceiling":
			return `${p.file}: fell from ${p.before} to ${p.after} — tighten the pin in tests/support/lsp-double-baseline.json to ${p.after}`;
		default:
			return `${p.file}: pinned at ${p.before} but the scan no longer flags it — delete the entry from tests/support/lsp-double-baseline.json`;
	}
}

async function scanFixture(name: string): Promise<HandRolledDouble[]> {
	return findHandRolledLspDoubles(
		fs.readFileSync(path.join(FIXTURES, name), "utf8"),
	);
}

describe("#2582 hand-rolled LSPService double ratchet", () => {
	let live: Record<string, number>;
	beforeAll(async () => {
		live = await liveCounts();
	}, 120_000);

	it("no new file, no risen count, no stale pin", () => {
		expect(auditAgainstBaseline(live).map(describeProblem)).toEqual([]);
	});

	it("the migrated pipeline and runtime-session seams stay on the factory", () => {
		// The files #2582 migrated. Naming them explicitly means a later edit
		// that hand-rolls a double back into one of them fails HERE with a
		// readable message, not only as a "new-file" line above.
		const migrated = [
			"tests/clients/cascade-compute.test.ts",
			"tests/clients/dispatch/lazy-liveness.test.ts",
			"tests/clients/dispatch/runners/runner-status-semantics.test.ts",
			"tests/clients/formatters-lazy-liveness.test.ts",
			"tests/clients/pi-host-contract.test.ts",
			"tests/clients/pipeline-lsp-sync.test.ts",
			"tests/clients/pipeline.test.ts",
			"tests/clients/runtime-session-warm.test.ts",
			"tests/clients/runtime-session-warmup-oneshot.test.ts",
			"tests/clients/runtime-session-warmup-prewarm.test.ts",
			"tests/clients/runtime-session-warmup-supersession.test.ts",
			"tests/clients/runtime-session.test.ts",
			"tests/clients/runtime-tool-call.test.ts",
			"tests/clients/word-index-lifecycle.test.ts",
			"tests/clients/write-autofix-attachment-message.test.ts",
		];
		expect(migrated.filter((file) => file in live)).toEqual([]);
	});
});

describe("#2582 detector — the shapes the round-1 regex could not see", () => {
	// Each case reads a REAL file from tests/fixtures/lsp-double-gate through
	// the same read-and-parse path as the population walk. `touchFile: vi.fn(`
	// matches NONE of the five.
	const REGEX_ROUND_1 = /touchFile\s*:\s*vi\.fn\s*\(/;

	it.each([
		["shape-a-shorthand.ts", "shorthand properties"],
		["shape-b-plain-async.ts", "a plain async stub, no vi.fn at all"],
		["shape-c-post-hoc.ts", "post-hoc property assignment"],
		["shape-d-multiline.ts", "vi + newline + .fn()"],
		["shape-e-alias-laundered.ts", "const makeTouchFileMock = vi.fn"],
	])("flags %s (%s)", async (fixture) => {
		const source = fs.readFileSync(path.join(FIXTURES, fixture), "utf8");
		expect(REGEX_ROUND_1.test(source)).toBe(false);
		expect(await scanFixture(fixture)).not.toEqual([]);
	});

	it.each([
		["compliant-factory-override.ts", "focused overrides on a seeded object"],
		["compliant-lsp-client-double.ts", "a fake LSP client, a different seam"],
	])("does NOT flag %s (%s)", async (fixture) => {
		expect(await scanFixture(fixture)).toEqual([]);
	});

	it("derives its vocabulary from the factory, not from a hand-copied list", () => {
		// Single source of truth: adding a method to makeLspServiceDouble widens
		// the detector in the same commit. A mirrored roster is the defect
		// AGENTS.md forbids.
		const vocabulary = lspServiceMethodNames();
		expect(vocabulary.has("touchFile")).toBe(true);
		expect(vocabulary.has("getAuxiliaryClientsForFile")).toBe(true);
		expect(vocabulary.size).toBeGreaterThan(15);
	});
});
