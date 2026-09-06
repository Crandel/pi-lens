// Pure helpers behind scripts/resolve-newest-in-range-host.mjs (#2613) — kept
// side-effect-free (no fs/child_process/npm) so the semver-selection logic is
// unit-testable without a live npm registry, mirroring
// scripts/lib/drift-issue.mjs's own testing pattern (that file tests the
// issue-body/lookup logic, not the workflow step that shells out to `gh`;
// this tests the version-selection logic, not the script that shells out to
// `npm view`).
//
// WHY THIS EXISTS (#2590 recurrence, #2613)
// install-smoke.yml's PR-gating lanes install the pinned floor host AND the
// newest pi-coding-agent version this repo's declared peerDependencies range
// admits, so a peer-range change (like #2588) is exercised on the exact host
// it newly admits, before it ships. Reading the range straight out of
// package.json (rather than duplicating it as a separate workflow input)
// keeps the install lane and the declared range in agreement BY
// CONSTRUCTION — a future range edit changes what this resolves on its very
// next run, no second edit required.

import semver from "semver";

/**
 * Read the declared peerDependencies range for `packageName` out of a parsed
 * package.json object.
 *
 * @param {Record<string, unknown>} pkg
 * @param {string} packageName
 * @returns {string}
 */
export function readPeerRange(pkg, packageName) {
	const range =
		/** @type {Record<string, unknown> | undefined} */ (
			pkg?.peerDependencies
		)?.[packageName];
	if (typeof range !== "string" || range.trim() === "") {
		throw new Error(
			`package.json has no peerDependencies["${packageName}"] entry`,
		);
	}
	return range;
}

/**
 * Pick the highest published version in `versions` that satisfies `range`,
 * excluding prereleases (a prerelease is never a real "newest stable host").
 * Returns null when nothing satisfies — the caller turns that into exit 4.
 *
 * `semver.maxSatisfying` already tolerates invalid/garbage version strings
 * (skips them rather than throwing) and, with `includePrerelease: false`
 * (its own default), already excludes prereleases — a separate pre-filter
 * for either would be dead code, so `versions` is passed straight through.
 *
 * @param {string[]} versions
 * @param {string} range
 * @returns {string | null}
 */
export function pickNewestInRange(versions, range) {
	return semver.maxSatisfying(versions ?? [], range, {
		includePrerelease: false,
	});
}
