// Types for the (plain-JS) release-QA runner, so the TS unit test can hold its
// pure parts — matrix parsing, the outcome rules, the coverage arithmetic and
// the ship verdict — without spawning a real pi. Driving a real pi is the
// runner's own job and install-smoke's lane, never the unit suite's.

export interface BaselineRow {
	id: string;
	feature: string;
	modality: string;
	entryPoint: string;
	passCriterion: string;
	witness: string;
	reuse: string;
	umbrella: string;
}

export interface ParsedBaseline {
	rows: BaselineRow[];
	errors: string[];
}

export interface ProbeReport {
	status?: string;
	detail?: string;
}

export interface RowResult {
	id: string;
	outcome: string;
	detail: string;
	implemented?: boolean;
	witnessPath?: string;
	shows?: string;
}

export interface Coverage {
	discovered: number;
	rows: number;
	pass: number;
	fail: number;
	untested: number;
	skipped: number;
	balanced: boolean;
}

export interface Verdict {
	verdict:
		| "SHIP"
		| "SHIP-WITH-CAVEATS"
		| "DO-NOT-SHIP"
		| "BLOCKED"
		| "INCONCLUSIVE";
	reason: string;
	caveats: string[];
}

export interface RunnerOptions {
	pi: string;
	from: string;
	baseline: string;
	out: string;
	pollCapMs: number;
	gitRef?: string;
	keep: boolean;
}

export const BASELINE_TABLE_MARKER: string;
export const BASELINE_COLUMNS: readonly string[];
export const OUTCOME: {
	readonly PASS: "PASS";
	readonly FAIL: "FAIL";
	readonly UNTESTED: "UNTESTED";
	readonly SKIPPED: "SKIPPED";
};

export function parseBaselineRows(text: string): ParsedBaseline;
export function classifyRowOutcome(probe: ProbeReport | null | undefined): {
	outcome: string;
	detail: string;
};
export function formatOutcome(result: {
	outcome: string;
	detail?: string;
}): string;
export function coverageArithmetic(
	results: ReadonlyArray<{ outcome: string; implemented?: boolean }>,
	discoveredCount?: number,
): Coverage;
export function renderCoverageLine(coverage: Coverage): string;
export function shipVerdict(
	results: ReadonlyArray<RowResult>,
	options?: { blocked?: boolean; blockedReason?: string },
): Verdict;
/**
 * The runner's exit-code contract.
 *
 * | code | verdict | meaning |
 * | --- | --- | --- |
 * | 0 | SHIP | every discovered row PASSED with a witness |
 * | 1 | DO-NOT-SHIP | a row FAILED, or the candidate would not install/activate |
 * | 2 | SHIP-WITH-CAVEATS | every witnessed row passed, some produced no witness |
 * | 3 | BLOCKED / INCONCLUSIVE | no verdict: pi did not boot, or nothing was witnessed |
 * | 4 | usage or self-check error | bad option, unparseable baseline, arithmetic mismatch |
 *
 * **2 is the EXPECTED verdict for a plain working-tree run** — `git-install`
 * is SKIPPED without `--git-ref`. A CI lane treats 2 as a warning, 1/3/4 as
 * failures.
 */
/**
 * The refusal message for a dirty checkout, or null when it is clean. A
 * `--from tree` run packs `git archive HEAD`, so an uncommitted edit would be
 * QA'd as its last commit — a usage error (exit 4), not a candidate failure.
 */
export function dirtyCheckoutRefusal(porcelain: string): string | null;

/**
 * Split `supply-host-provided-deps.mjs --install-args` output into argv
 * entries — newline-delimited, because a peer range may contain a space
 * (`^0.84.1 || ^0.85.0`, #2586).
 */
export function parseSupplyArgs(stdout: string): string[];

export function verdictExitCode(verdict: string): number;

/**
 * The pinned scratch environment every child process runs under. Its keys are
 * enumerated by `PINNED_ENV_KEYS`.
 */
export function scratchEnv(
	scratchRoot: string,
	extra?: Record<string, string>,
): NodeJS.ProcessEnv;

/** Every variable `scratchEnv` pins inside the scratch root. */
export const PINNED_ENV_KEYS: readonly string[];
export function renderReport(input: {
	rows: ReadonlyArray<BaselineRow>;
	results: ReadonlyArray<RowResult>;
	coverage: Coverage;
	verdict: Verdict;
	context?: Record<string, string>;
}): string;
export function pollToTerminal(
	attempt: () => Promise<{ terminal: boolean; detail: string }>,
	options: { capMs: number; intervalMs: number },
): Promise<{
	status: "terminal" | "expired";
	attempts: number;
	value: { terminal: boolean; detail: string };
	detail?: string;
}>;
export function parseArgs(argv: readonly string[]): RunnerOptions;
export function implementedRowIds(): string[];
