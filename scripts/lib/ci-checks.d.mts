export declare const REQUIRED_CHECKS: string[];
export declare const ADVISORY_SUFFIX: string;
export declare const ADVISORY_CHECKS: Set<string>;
export declare function isAdvisoryCheck(name: string): boolean;
export declare const BLOCKING_CONCLUSIONS: Set<string>;
export declare function isBlockingConclusion(
	conclusion: string | null | undefined,
): boolean;
export declare function isUncertainConclusion(
	conclusion: string | null | undefined,
): boolean;

export interface CheckRunRecord {
	name: string;
	status?: string | null;
	conclusion?: string | null;
	startedAt?: string | null;
	started_at?: string | null;
	[key: string]: unknown;
}

export declare function preferCheckRun<T extends CheckRunRecord>(a: T, b: T): T;

export declare function resolveLatestByName<T extends CheckRunRecord>(
	checkRuns: T[] | null | undefined,
): Map<string, T>;
