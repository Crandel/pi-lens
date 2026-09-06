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
	verdict: "SHIP" | "SHIP-WITH-CAVEATS" | "DO-NOT-SHIP" | "BLOCKED";
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
export function classifyProbe(probe: ProbeReport | null | undefined): {
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
export function verdictExitCode(verdict: string): number;
export function renderReport(input: {
	rows: ReadonlyArray<BaselineRow>;
	results: ReadonlyArray<RowResult>;
	coverage: Coverage;
	verdict: Verdict;
	context?: Record<string, string>;
}): string;
export function pollToTerminal(
	attempt: () => Promise<{ terminal: boolean; detail: string }>,
	options: { capMs: number; intervalMs?: number },
): Promise<{
	status: "terminal" | "expired";
	attempts: number;
	value: { terminal: boolean; detail: string };
	detail?: string;
}>;
export function parseArgs(argv: readonly string[]): RunnerOptions;
export function implementedRowIds(): string[];
