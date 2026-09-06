// Type declarations for install-smoke-drift.mjs (untyped .mjs imported from
// .ts tests). #2613.

export const INSTALL_SMOKE_DRIFT_TITLE: string;

export type StepOutcome = "success" | "failure" | "skipped";

export interface InstallSmokeDriftReport {
	version: string;
	steps: { name: string; outcome: StepOutcome }[];
}

export function firstFailingStep(report: InstallSmokeDriftReport): string | null;

export function hasDrift(report: InstallSmokeDriftReport): boolean;

export function buildInstallSmokeDriftBody(
	report: InstallSmokeDriftReport,
	opts?: { runUrl?: string | null },
): string;

export function buildInstallSmokeDriftComment(
	report: InstallSmokeDriftReport,
): string;
