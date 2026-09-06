#!/usr/bin/env node
/**
 * #2613 (review S2/T3): makes a genuine install-smoke `host-latest-smoke`
 * nightly failure ACTIONABLE, and closes the tracker once it resolves — the
 * acceptance criterion this PR's first round missed ("closed when green
 * again"). File-or-update a SINGLE persistent tracking issue on failure,
 * found by exact title match (scripts/lib/drift-issue.mjs's
 * `findDriftTrackingIssue`, generalized in this PR to take an explicit
 * title so this is its SECOND consumer, not a third hand-rolled gh-issue-
 * upsert copy — install-smoke.yml previously embedded this logic a third
 * time directly in workflow YAML bash).
 *
 * Reads the run's step outcomes from env (set by the workflow step that
 * invokes this script) rather than argv, so the workflow's own `steps.*.outcome`
 * expressions are the single source of truth for what happened — this
 * script never re-derives success/failure itself.
 *
 * Required env (each: success | failure | skipped, except RESOLVED_VERSION):
 *   RESOLVED_VERSION           the @latest version this run installed
 *   RESOLVE_OUTCOME            resolving that version itself (a registry
 *                              failure here leaves every step below
 *                              "skipped", never "failure" -- this one must
 *                              be in the table or a total resolve failure
 *                              reads as a clean run)
 *   INSTALL_CI_OUTCOME
 *   INSTALL_DEPS_OUTCOME
 *   GRAMMARS_OUTCOME
 *   BUILD_DIST_OUTCOME
 *   PACK_OUTCOME
 *   INSTALL_TARBALL_OUTCOME
 *   SELFTEST_OUTCOME
 * Optional: GITHUB_TOKEN (gh auth), GITHUB_SERVER_URL/GITHUB_REPOSITORY/
 *   GITHUB_RUN_ID (workflow-run link in the issue body).
 *
 *   node scripts/notify-install-smoke-drift.mjs                    # real gh calls
 *   node scripts/notify-install-smoke-drift.mjs --dry-run          # compute + print the plan, no gh calls
 *
 * Never lets an internal error escape as a nonzero exit — this step's own
 * `continue-on-error`/advisory framing means filing/closing an issue is a
 * side effect, not a build gate, mirroring notify-clean-signal-drift.mjs.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { findDriftTrackingIssue } from "./lib/drift-issue.mjs";
import {
	buildInstallSmokeDriftBody,
	buildInstallSmokeDriftComment,
	hasDrift,
	INSTALL_SMOKE_DRIFT_TITLE,
} from "./lib/install-smoke-drift.mjs";

const STEP_NAMES = /** @type {const} */ ([
	["RESOLVE_OUTCOME", "resolve @latest"],
	["INSTALL_CI_OUTCOME", "install deps (ci)"],
	["INSTALL_DEPS_OUTCOME", "pin devDependency (no-save)"],
	["GRAMMARS_OUTCOME", "download grammars"],
	["BUILD_DIST_OUTCOME", "build:dist"],
	["PACK_OUTCOME", "npm pack"],
	["INSTALL_TARBALL_OUTCOME", "install tarball"],
	["SELFTEST_OUTCOME", "install-selftest"],
]);

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");

function gh(args) {
	return execFileSync("gh", args, { encoding: "utf8" });
}

function readReport(env) {
	const version = env.RESOLVED_VERSION ?? "unknown";
	const steps = STEP_NAMES.map(([envVar, name]) => ({
		name,
		outcome:
			/** @type {import("./lib/install-smoke-drift.d.mts").StepOutcome} */ (
				env[envVar] ?? "skipped"
			),
	}));
	return { version, steps };
}

function workflowRunUrl(env) {
	const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = env;
	if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return null;
	return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
}

function findTrackingIssue() {
	try {
		const out = gh([
			"issue",
			"list",
			"--search",
			`in:title "${INSTALL_SMOKE_DRIFT_TITLE}"`,
			"--state",
			"open",
			"--json",
			"number,title",
			"--limit",
			"20",
		]);
		return findDriftTrackingIssue(JSON.parse(out), INSTALL_SMOKE_DRIFT_TITLE);
	} catch (e) {
		console.error(
			`[notify-install-smoke-drift] gh issue list failed, treating as "no existing issue": ${e?.message ?? e}`,
		);
		return null;
	}
}

function writeBodyToTempFile(body) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pilens-install-drift-"));
	const file = path.join(dir, "body.md");
	fs.writeFileSync(file, body);
	return file;
}

function main(env) {
	const report = readReport(env);
	const body = buildInstallSmokeDriftBody(report, {
		runUrl: workflowRunUrl(env),
	});

	if (dryRun) {
		console.log(
			`[notify-install-smoke-drift] DRY RUN — drift=${hasDrift(report)}. Plan body:\n`,
		);
		console.log(body);
		return;
	}

	const existing = findTrackingIssue();

	if (hasDrift(report)) {
		const bodyFile = writeBodyToTempFile(body);
		try {
			if (existing) {
				gh(["issue", "edit", String(existing.number), "--body-file", bodyFile]);
				gh([
					"issue",
					"comment",
					String(existing.number),
					"--body",
					buildInstallSmokeDriftComment(report),
				]);
				console.log(
					`[notify-install-smoke-drift] updated tracking issue #${existing.number}.`,
				);
			} else {
				gh([
					"issue",
					"create",
					"--title",
					INSTALL_SMOKE_DRIFT_TITLE,
					"--label",
					"area:installer,area:tests",
					"--body-file",
					bodyFile,
				]);
				console.log("[notify-install-smoke-drift] filed a new tracking issue.");
			}
		} catch (e) {
			console.error(
				`[notify-install-smoke-drift] gh issue create/edit failed: ${e?.message ?? e}`,
			);
		}
		return;
	}

	if (existing) {
		try {
			gh([
				"issue",
				"close",
				String(existing.number),
				"--comment",
				`Nightly install-smoke ran \`@latest\` (${report.version}) cleanly — self-resolved, closing (#2613).`,
			]);
			console.log(
				`[notify-install-smoke-drift] closed tracking issue #${existing.number} (drift resolved).`,
			);
		} catch (e) {
			console.error(
				`[notify-install-smoke-drift] gh issue close failed: ${e?.message ?? e}`,
			);
		}
		return;
	}

	console.log(
		"[notify-install-smoke-drift] no drift, no open tracking issue — nothing to do.",
	);
}

try {
	main(process.env);
} catch (e) {
	console.error(
		`[notify-install-smoke-drift] unexpected error (never fails the job): ${e?.message ?? e}`,
	);
}
process.exit(0);
