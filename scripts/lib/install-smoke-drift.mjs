// Pure helpers behind scripts/notify-install-smoke-drift.mjs (#2613 review
// S2/T3) — kept side-effect-free (no fs/child_process/gh) so the body/lookup
// logic is unit-testable without a live `gh` CLI, mirroring
// scripts/lib/drift-issue.mjs's own testing pattern for the SAME reason
// (that file: nightly `tool-smoke` silentOnClean drift; this file: nightly
// `install-smoke` host-latest install drift). `findDriftTrackingIssue` from
// drift-issue.mjs is reused directly (its title parameter was generalized
// for this second consumer) rather than a second title-matching copy.

export const INSTALL_SMOKE_DRIFT_TITLE =
	"install-smoke: pi-coding-agent@latest install drift detected";

/** @typedef {"success" | "failure" | "skipped"} StepOutcome */

/**
 * @typedef {Object} InstallSmokeDriftReport
 * @property {string} version
 * @property {{ name: string, outcome: StepOutcome }[]} steps
 */

/**
 * The name of the first step whose outcome is "failure", in step order —
 * what the tracking issue names as "the failing step" (#2613 acceptance).
 *
 * @param {InstallSmokeDriftReport} report
 * @returns {string | null}
 */
export function firstFailingStep(report) {
	return report.steps.find((s) => s.outcome === "failure")?.name ?? null;
}

/**
 * @param {InstallSmokeDriftReport} report
 * @returns {boolean}
 */
export function hasDrift(report) {
	return firstFailingStep(report) !== null;
}

/**
 * Build the tracking issue's Markdown body for a FAILING nightly run. Pure
 * string building — no I/O.
 *
 * @param {InstallSmokeDriftReport} report
 * @param {{ runUrl?: string | null }} [opts]
 * @returns {string}
 */
export function buildInstallSmokeDriftBody(report, opts = {}) {
	const failingStep = firstFailingStep(report);
	const lines = [
		"The nightly `install-smoke` workflow's advisory lane installed" +
			` \`@earendil-works/pi-coding-agent@${report.version}\`` +
			" (the `latest` dist-tag, resolved at run time) and hit a failure —" +
			" a pi release outside this repo's declared peerDependencies range" +
			" broke the install path (#2613).",
		"",
		`- Installed version: **${report.version}**`,
		`- Failing step: **${failingStep ?? "unknown"}**`,
		"",
		"| step | outcome |",
		"| --- | --- |",
		...report.steps.map((s) => `| ${s.name} | ${s.outcome} |`),
	];
	if (opts.runUrl) {
		lines.push("", `Workflow run: ${opts.runUrl}`);
	}
	lines.push(
		"",
		"_This issue is auto-refreshed by the nightly `install-smoke` workflow's" +
			" advisory lane — do not close it while the check is failing. It is" +
			" closed automatically once a nightly run installs `@latest` cleanly._",
	);
	return lines.join("\n");
}

/**
 * The comment posted when an EXISTING tracking issue is refreshed by
 * another failing run (never a new issue every night).
 *
 * @param {InstallSmokeDriftReport} report
 * @returns {string}
 */
export function buildInstallSmokeDriftComment(report) {
	return `Still failing: installed ${report.version}, failing step: ${firstFailingStep(report) ?? "unknown"}.`;
}
