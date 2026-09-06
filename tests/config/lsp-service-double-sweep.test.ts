/**
 * #2582 — hand-rolled `LSPService` doubles: a semantic sweep, a two-sided
 * ratchet, and a two-part admission gate.
 *
 * The recurrence this guards: a test stubs `getLSPService` with a partial,
 * hand-rolled object, production later calls a method that object does not
 * have, and the failure lands in a swallow-all catch. It has cost three rounds
 * already — #1766 F3 (`isSpawnInFlight`), #2540/#2582 F3
 * (`getAuxiliaryClientsForFile`), and the CI red on this branch's first head
 * (`tests/clients/lsp-lazy-liveness.test.ts:88`). `makeLspServiceDouble` gives
 * every such test the full surface with focused overrides; this sweep keeps
 * the hand-rolled population from growing back.
 *
 * ## Why a ratchet and not a clean gate
 *
 * 18 hand-rolled doubles in 17 files survive today, on seams this issue did
 * not scope (`tests/tools/lsp-*`, `tests/clients/mcp/*`,
 * `tests/clients/actionable-warnings*`, `dispatch/runners/pyright-*`). They
 * are pinned in `tests/support/lsp-double-baseline.json` and tracked to burn
 * down in #2592.
 *
 * ## The admission gate, and why it exists
 *
 * Round 2 shipped this ratchet with the defect the ratchet exists to stop, one
 * level up: a brand-new test file carrying a hand-rolled double, plus ONE line
 * added to the baseline JSON, passed the whole suite — no reason, no second
 * gate. That is #2582 round 1's identifier laundering in a new spelling, and
 * it is AGENTS.md defect shape 38: a guard a one-line data edit satisfies
 * away.
 *
 * So a pin is now provenance-checked. {@link ORIGINAL_POPULATION} records what
 * was pinned when this ratchet was minted. Any baseline key outside it must
 * ALSO appear in {@link ADMITTED_AFTER_BASELINE} with a real reason naming an
 * issue, AND the admitted file must carry its own
 * `// lsp-double: <reason>` header. Two parts, in two different files, one of
 * them source-reviewed — a data edit alone admits nothing. This is the same
 * shape as `tests/clients/flake-shape-ratchet.test.ts`'s admission gate
 * (header + `wallClockBudgetInclude` membership), reused rather than
 * re-derived.
 *
 * `ORIGINAL_POPULATION` is NOT a mirror of the baseline JSON: it is an
 * append-only record of a historical fact and keeps naming files after they
 * are burned down, which is what makes "was this pin admitted or smuggled?"
 * answerable. Pruning it would let a burned-down file be re-pinned silently.
 *
 * ## The rules
 *
 * Live-vs-pin, two-sided: `new-file`, `count-risen`, `stale-ceiling`,
 * `vanished-pin`. Provenance: `unadmitted-pin`, `missing-header`,
 * `reason-not-real`, `dead-admission`. The PR body for #2585 carries the
 * (state × writer) cell list; every cell below has a test.
 *
 * ## Why the detector is structural
 *
 * Round 1 of this sweep was the literal string `touchFile: vi.fn(`, and it
 * shipped with 28 `const makeTouchFileMock = vi.fn;` call sites in
 * `cascade-compute.test.ts` whose only purpose was to rename the literal out
 * of its own reach. `tests/support/lsp-double-gate.ts` replaces it with an AST
 * walk from the `getLSPService` seam; the five shapes that defeated the regex
 * are pinned below as REAL FIXTURE FILES under
 * `tests/fixtures/lsp-double-gate/`, read and parsed through the same path as
 * the population walk — a string concatenated inside this file would only
 * prove the sweep agrees with itself.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
	admissionHeader,
	findHandRolledLspDoubles,
	lspServiceMethodNames,
	repoRoot,
} from "../support/lsp-double-gate.js";
import { makeLspServiceDouble } from "../support/lsp-service-double.js";
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

/**
 * The population as minted by #2585 (2026-09-06). APPEND-ONLY: an entry stays
 * here after its file is migrated, because this list answers "was this pin
 * part of the original debt?", not "what is pinned today". Pruning a
 * burned-down file would let it be re-pinned without an admission.
 */
const ORIGINAL_POPULATION: ReadonlySet<string> = new Set([
	"tests/clients/actionable-warnings-bounds.test.ts",
	"tests/clients/actionable-warnings-deferred-bounds.test.ts",
	"tests/clients/actionable-warnings-history.test.ts",
	"tests/clients/actionable-warnings-lsp-cache.test.ts",
	"tests/clients/actionable-warnings.test.ts",
	"tests/clients/dispatch/runners/pyright-environment.test.ts",
	"tests/clients/lsp-document-symbols.test.ts",
	"tests/clients/lsp/late-auxiliary-findings.test.ts",
	"tests/clients/mcp/analyze.test.ts",
	"tests/clients/mcp/session-context-eviction.test.ts",
	"tests/clients/mcp/session-test-findings-retire.test.ts",
	"tests/clients/mcp/session.test.ts",
	"tests/clients/warm-attach-confirmation.test.ts",
	"tests/tools/lsp-diagnostics-cache.test.ts",
	"tests/tools/lsp-diagnostics-inferred-project.test.ts",
	"tests/tools/lsp-diagnostics-per-server-concurrency.test.ts",
	"tests/tools/lsp-diagnostics.test.ts",
	"tests/tools/lsp-navigation.test.ts",
]);

/**
 * Pins added AFTER the baseline was minted. Empty in steady state — the same
 * merge-window device as `flake-shape-ratchet.test.ts`'s map of the same name.
 * An entry here is only half an admission: the file must also carry a
 * `// lsp-double: <reason>` header of its own.
 */
const ADMITTED_AFTER_BASELINE: Readonly<Record<string, string>> = {};

/** Shortest text this gate will accept as a reason, in either half. */
const MIN_REASON = 15;

// ── The scan ─────────────────────────────────────────────────────────────

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

// ── The two-sided live-vs-pin ratchet ────────────────────────────────────

interface RatchetProblem {
	file: string;
	kind: "new-file" | "count-risen" | "stale-ceiling" | "vanished";
	before?: number;
	after?: number;
}

export function auditAgainstBaseline(
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

const SEED_ADVICE =
	"seed from makeLspServiceDouble(), using omit for methods that must be absent";

function describeProblem(p: RatchetProblem): string {
	switch (p.kind) {
		case "new-file":
			return (
				`${p.file}: ${p.after} hand-rolled LSPService double(s) in a file the ` +
				`baseline has never seen — ${SEED_ADVICE}; a partial double is how ` +
				"#1766 F3 and #2582 F3 both shipped"
			);
		case "count-risen":
			return `${p.file}: rose from ${p.before} to ${p.after} hand-rolled double(s) — ${SEED_ADVICE}`;
		case "stale-ceiling":
			return `${p.file}: fell from ${p.before} to ${p.after} — tighten the pin in tests/support/lsp-double-baseline.json to ${p.after}`;
		default:
			return `${p.file}: pinned at ${p.before} but the scan no longer flags it — delete the entry from tests/support/lsp-double-baseline.json`;
	}
}

// ── The two-part admission gate ──────────────────────────────────────────

/**
 * Provenance for every baseline key, and liveness for every admission.
 *
 * Pulled out as a pure function taking all four inputs so it is unit-testable
 * against fixtures directly — `ADMITTED_AFTER_BASELINE` is empty in steady
 * state, so a test that only iterates the real map (as the sweep does) can
 * never prove this logic is mutation-sensitive. That is the lesson
 * `flake-shape-ratchet.test.ts` records for the same gate shape.
 */
export function auditAdmissions(
	baseline: Readonly<Baseline>,
	original: ReadonlySet<string>,
	admitted: Readonly<Record<string, string>>,
	readSource: (file: string) => string | undefined,
): string[] {
	const problems: string[] = [];

	for (const file of Object.keys(baseline)) {
		if (original.has(file)) continue;
		const reason = admitted[file];
		if (reason === undefined) {
			problems.push(
				`${file}: pinned in tests/support/lsp-double-baseline.json but never ` +
					"admitted. A pin is not a data edit: add an ADMITTED_AFTER_BASELINE " +
					"entry naming the issue that tracks it, AND a `// lsp-double: " +
					"<reason>` header in the file itself. Both parts are required " +
					`(AGENTS.md shape 38). Or ${SEED_ADVICE}.`,
			);
			continue;
		}
		if (reason.trim().length < MIN_REASON) {
			problems.push(
				`${file}: ADMITTED_AFTER_BASELINE reason is under ${MIN_REASON} characters — say why this double cannot use the factory`,
			);
		} else if (!/#\d+/.test(reason)) {
			problems.push(
				`${file}: ADMITTED_AFTER_BASELINE reason names no issue — an admission must point at tracked work (#NNN)`,
			);
		}
		const source = readSource(file);
		if (source === undefined) {
			problems.push(`${file}: admitted but the file does not exist`);
			continue;
		}
		const header = admissionHeader(source);
		if (!header) {
			problems.push(
				`${file}: admitted in ADMITTED_AFTER_BASELINE but carries no ` +
					"`// lsp-double: <reason>` header. Both parts are required " +
					"(AGENTS.md shape 38).",
			);
		} else if (header.length < MIN_REASON) {
			problems.push(
				`${file}: its \`// lsp-double:\` header reason is under ${MIN_REASON} characters — a marker is not a reason`,
			);
		}
	}

	for (const file of Object.keys(admitted)) {
		if (!(file in baseline)) {
			problems.push(
				`${file}: ADMITTED_AFTER_BASELINE names a file with no pin — delete the dead admission`,
			);
		}
	}

	return problems.sort();
}

function readRepoSource(file: string): string | undefined {
	const absolute = path.join(repoRoot, file);
	return fs.existsSync(absolute)
		? fs.readFileSync(absolute, "utf8")
		: undefined;
}

// ── The sweep ────────────────────────────────────────────────────────────

describe("#2582 hand-rolled LSPService double ratchet", () => {
	let live: Record<string, number>;
	beforeAll(async () => {
		live = await liveCounts();
	}, 120_000);

	it("no new file, no risen count, no stale pin", () => {
		expect(auditAgainstBaseline(live).map(describeProblem)).toEqual([]);
	});

	it("every pin is either original debt or a two-part admission", () => {
		expect(
			auditAdmissions(
				BASELINE,
				ORIGINAL_POPULATION,
				ADMITTED_AFTER_BASELINE,
				readRepoSource,
			),
		).toEqual([]);
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
			"tests/clients/lsp/late-auxiliary-findings.test.ts",
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

// ── The admission machine, cell by cell ──────────────────────────────────

/**
 * One (state × writer) cell of the PR-body table each. `ADMITTED_AFTER_BASELINE`
 * is empty in steady state, so these drive `auditAdmissions` against synthetic
 * inputs — the only way this logic is mutation-sensitive at all.
 */
describe("#2582 admission gate — the state space", () => {
	const NEW = "tests/clients/fresh-double.test.ts";
	const PINNED = "tests/tools/lsp-navigation.test.ts";
	const header = (reason: string) => `// lsp-double: ${reason}\nconst x = 1;\n`;
	const GOOD_REASON = "different seam, tracked in #2592";
	const noSource = () => undefined;
	const withHeader = (reason: string) => () => header(reason);

	it("C2: a bare pin — one baseline JSON line and nothing else — reds", () => {
		const problems = auditAdmissions(
			{ [NEW]: 1 },
			new Set(),
			{},
			withHeader(GOOD_REASON),
		);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("never admitted");
		expect(problems[0]).toContain("ADMITTED_AFTER_BASELINE");
		expect(problems[0]).toContain("lsp-double:");
	});

	it("C3: the ADMITTED map alone, without the file's header, reds", () => {
		const problems = auditAdmissions(
			{ [NEW]: 1 },
			new Set(),
			{ [NEW]: GOOD_REASON },
			() => "const x = 1;\n",
		);
		expect(problems).toEqual([
			expect.stringContaining("carries no `// lsp-double: <reason>` header"),
		]);
	});

	it("C4: the header alone, without an ADMITTED entry, reds", () => {
		const problems = auditAdmissions(
			{ [NEW]: 1 },
			new Set(),
			{},
			withHeader(GOOD_REASON),
		);
		expect(problems).toEqual([expect.stringContaining("never admitted")]);
	});

	it("C5: both parts present, with a real reason, passes", () => {
		expect(
			auditAdmissions(
				{ [NEW]: 1 },
				new Set(),
				{ [NEW]: GOOD_REASON },
				withHeader(GOOD_REASON),
			),
		).toEqual([]);
	});

	it("C6: an empty ADMITTED reason reds", () => {
		expect(
			auditAdmissions(
				{ [NEW]: 1 },
				new Set(),
				{ [NEW]: "   " },
				withHeader(GOOD_REASON),
			),
		).toEqual([expect.stringContaining(`under ${MIN_REASON} characters`)]);
	});

	it("C7: an ADMITTED reason naming no issue reds", () => {
		expect(
			auditAdmissions(
				{ [NEW]: 1 },
				new Set(),
				{ [NEW]: "this one is special, honestly" },
				withHeader(GOOD_REASON),
			),
		).toEqual([expect.stringContaining("names no issue")]);
	});

	it("C8: a header reason too short to be real reds", () => {
		expect(
			auditAdmissions(
				{ [NEW]: 1 },
				new Set(),
				{ [NEW]: GOOD_REASON },
				withHeader("todo"),
			),
		).toEqual([expect.stringContaining("a marker is not a reason")]);
	});

	it("C9/C20: an original pin needs no admission, before or after burn-down", () => {
		// Still pinned: no provenance problem.
		expect(
			auditAdmissions({ [PINNED]: 1 }, ORIGINAL_POPULATION, {}, noSource),
		).toEqual([]);
		// Burned down (pin removed): ORIGINAL_POPULATION keeps naming it, and
		// that is not a stale-entry problem — it is the record that stops a
		// silent re-pin.
		expect(auditAdmissions({}, ORIGINAL_POPULATION, {}, noSource)).toEqual([]);
	});

	it("C16/C17: an ADMITTED entry with no pin reds as a dead admission", () => {
		expect(
			auditAdmissions({}, new Set(), { [NEW]: GOOD_REASON }, noSource),
		).toEqual([expect.stringContaining("no pin — delete the dead admission")]);
	});

	it("C15: removing pin, admission and doubles together passes", () => {
		expect(auditAdmissions({}, new Set(), {}, noSource)).toEqual([]);
	});

	it("admits a file that has vanished from disk only as a problem", () => {
		expect(
			auditAdmissions(
				{ [NEW]: 1 },
				new Set(),
				{ [NEW]: GOOD_REASON },
				noSource,
			),
		).toEqual([expect.stringContaining("the file does not exist")]);
	});
});

describe("#2582 live-vs-pin ratchet — the four directions", () => {
	const F = "tests/tools/lsp-navigation.test.ts";

	it("C1/C21: a file the baseline has never seen reds; so does a pin with no live hit", () => {
		expect(auditAgainstBaseline({ [F]: 1 }, {}).map(describeProblem)).toEqual([
			expect.stringContaining("the baseline has never seen"),
		]);
		expect(auditAgainstBaseline({}, { [F]: 1 }).map(describeProblem)).toEqual([
			expect.stringContaining("the scan no longer flags it"),
		]);
	});

	it("C10/C11: a risen count and a fallen count both red", () => {
		expect(auditAgainstBaseline({ [F]: 3 }, { [F]: 1 })[0].kind).toBe(
			"count-risen",
		);
		expect(auditAgainstBaseline({ [F]: 1 }, { [F]: 3 })[0].kind).toBe(
			"stale-ceiling",
		);
	});

	it("C13/C14: burn-down passes only when the pin goes with the doubles", () => {
		expect(auditAgainstBaseline({}, {})).toEqual([]);
		expect(auditAgainstBaseline({ [F]: 1 }, {})[0].kind).toBe("new-file");
	});
});

describe("#2582 factory contract", () => {
	it("omit leaves the named method ABSENT, not stubbed", () => {
		// The production fallbacks this factory has to be able to exercise are
		// `typeof service.method === "function"` checks (clients/pipeline.ts
		// ~1145, #1766 F3). A default that merely returns false is a DIFFERENT
		// state: it never reaches the fallback. Without this, `omit` is
		// indistinguishable from its absence in every suite that uses it —
		// a mutation probe that neutered `omit` left the whole
		// pipeline-lsp-sync suite green.
		const omitted = makeLspServiceDouble({}, { omit: ["isSpawnInFlight"] });
		expect("isSpawnInFlight" in omitted).toBe(false);
		expect("touchFile" in omitted).toBe(true);
	});

	it("overrides replace a default without dropping the rest of the surface", () => {
		const touchFile = vi.fn();
		const service = makeLspServiceDouble({ touchFile });
		expect(service.touchFile).toBe(touchFile);
		expect(typeof service.getAuxiliaryClientsForFile).toBe("function");
	});
});

describe("#2582 detector — the shapes the round-1 regex could not see", () => {
	// Each case reads a REAL file from tests/fixtures/lsp-double-gate through
	// the same read-and-parse path as the population walk. `touchFile: vi.fn(`
	// matches NONE of the five.
	const REGEX_ROUND_1 = /touchFile\s*:\s*vi\.fn\s*\(/;
	const scanFixture = (name: string, vocabulary?: ReadonlySet<string>) =>
		findHandRolledLspDoubles(
			fs.readFileSync(path.join(FIXTURES, name), "utf8"),
			vocabulary,
		);

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

	it("the OBJECT rule does not read the vocabulary — the seam is the anchor", () => {
		// #2582 round 3, N2. Round 2 computed `vocabulary ∩ keys` on every
		// object hit, stored it, and never gated on it, while the docstring
		// claimed the vocabulary filtered the object rule. Emptying the
		// vocabulary must leave every object-shaped hit EXACTLY where it was:
		// an object the seam receives that the factory did not seed is
		// hand-rolled whatever it carries.
		const objectShapes = [
			"shape-a-shorthand.ts",
			"shape-b-plain-async.ts",
			"shape-d-multiline.ts",
			"shape-e-alias-laundered.ts",
		];
		return Promise.all(
			objectShapes.map(async (fixture) => {
				const withVocabulary = await scanFixture(fixture);
				const without = await scanFixture(fixture, new Set<string>());
				expect(without).toEqual(withVocabulary);
				expect(without).not.toEqual([]);
			}),
		);
	});

	it("the POST-HOC rule DOES read the vocabulary — there it is load-bearing", async () => {
		// The mirror of the test above, and the only place the vocabulary
		// decides anything: `service.foo = …` has no other signal than the
		// property name. Emptying the vocabulary must red exactly this fixture.
		expect(await scanFixture("shape-c-post-hoc.ts")).not.toEqual([]);
		expect(await scanFixture("shape-c-post-hoc.ts", new Set<string>())).toEqual(
			[],
		);
	});

	it("the vocabulary is derived from the factory, not from a hand-copied list", () => {
		const vocabulary = lspServiceMethodNames();
		expect(vocabulary).toEqual(new Set(Object.keys(makeLspServiceDouble())));
		expect(vocabulary.has("touchFile")).toBe(true);
	});
});
