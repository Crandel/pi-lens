// Locates the on-disk source file(s) a pinned compat contract (#476) reads,
// trying an ORDERED list of candidate paths per file role instead of a single
// hardcoded path (#2581).
//
// A contract's Layer A verification can go wrong two different ways, and
// #2581 was exactly the case where the nightly conflated them:
//
//   - the file might not exist ANYWHERE we know to look (the third-party
//     package's layout changed/renamed/moved the file) — we haven't actually
//     re-checked the contract's CONTENT at all, so this is an INFRA outcome;
//   - the file exists but its content no longer matches the pinned regex
//     shape — real upstream DRIFT.
//
// `locateContractSource`/`locateContractSources` only ever answer the first
// question (found vs not found); scripts/lib/compat-contracts.mjs's regex
// checks answer the second. scripts/compat-contracts.mjs (the orchestration
// script) composes the two so each of the seven pinned contracts gets its
// own independent verified/drift/infra outcome instead of one relocated file
// blinding verification of every other contract, which is what happened when
// pi-subagents@0.65.0 moved `src/runs/shared/pi-args.ts`.
//
// Kept to the two fs calls this needs (existsSync + readFileSync) — no
// network, no child_process — so it's unit-testable against a small on-disk
// fixture package tree without npm-installing anything real.

import * as fs from "node:fs";
import * as path from "node:path";

/** @typedef {{ path: string, observedAt: string }} ContractSourceCandidate */

/**
 * Resolve the first existing candidate file under `packageDir`.
 *
 * @param {string} packageDir absolute path to the installed package
 *   (e.g. `<scratch>/node_modules/pi-subagents`) to resolve candidates against
 * @param {ContractSourceCandidate[]} candidates tried in order — put the
 *   version each was OBSERVED at so a failure detail can say exactly what
 *   was tried and when it was last known to work
 * @returns {{ found: true, relativePath: string, observedAt: string, source: string }
 *         | { found: false, tried: ContractSourceCandidate[] }}
 */
export function locateContractSource(packageDir, candidates) {
	for (const candidate of candidates) {
		const filePath = path.join(packageDir, candidate.path);
		if (fs.existsSync(filePath)) {
			return {
				found: true,
				relativePath: candidate.path,
				observedAt: candidate.observedAt,
				source: fs.readFileSync(filePath, "utf8"),
			};
		}
	}
	return { found: false, tried: candidates };
}

/**
 * Resolve every file role ("part") a contract's check function needs and
 * concatenate their sources. A contract can need more than one file — e.g.
 * nicobailon.child-env's env-flag CONST and its ASSIGNMENT site live in two
 * different files as of pi-subagents@0.65.0's native-session rewrite (#2581),
 * where they used to be co-located in one `pi-args.ts`. Fails as a whole the
 * moment any required part can't be located, since running a regex check
 * against a partial concatenation would be meaningless.
 *
 * @param {string} packageDir
 * @param {{ name: string, candidates: ContractSourceCandidate[] }[]} parts
 * @returns {{ found: true, source: string, parts: Array<{ name: string, relativePath: string, observedAt: string }> }
 *         | { found: false, part: string, tried: ContractSourceCandidate[] }}
 */
export function locateContractSources(packageDir, parts) {
	const resolvedParts = [];
	for (const part of parts) {
		const result = locateContractSource(packageDir, part.candidates);
		if (!result.found) {
			return { found: false, part: part.name, tried: result.tried };
		}
		resolvedParts.push({
			name: part.name,
			relativePath: result.relativePath,
			observedAt: result.observedAt,
			source: result.source,
		});
	}
	return {
		found: true,
		source: resolvedParts.map((p) => p.source).join("\n"),
		parts: resolvedParts.map(({ source: _source, ...meta }) => meta),
	};
}
