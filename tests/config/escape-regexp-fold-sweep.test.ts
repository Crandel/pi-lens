/**
 * #2558: forbid a NEW copy of the regex-escaping helper outside
 * `clients/string-utils.ts`.
 *
 * Before this issue, `escapeRegExp` (and near-namesakes `escapeRegExpChar`,
 * `escapeRegExpLiteral`, and a renamed `escapeRegex`) was hand-copied into
 * eight production modules and four test helpers, all with the byte-identical
 * body `x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")` — found by grepping the
 * NAME (`function escapeRegExp`), which a renamed copy trivially evades
 * (`scripts/lib/astgrep-self-scan.mjs` shipped exactly that: `escapeRegex`,
 * same body, different name). `clients/string-utils.ts` now owns the one
 * runtime copy and `tests/support/sweep-kit.ts` re-exports it for the test
 * side; every former copy imports from one of those instead.
 *
 * This sweep matches the ESCAPING BODY, not the function's name (AGENTS.md
 * defect shape 38 — "cheapest evasion" screen: a guard that only matches a
 * name is defeated by a rename that keeps the body). It flags two shapes,
 * both meaning "a reusable escaping helper duplicates this body":
 *
 *   A. `function <name>(<param>) { ... return <param>.replace(<escape>); }`
 *   B. `(<param>) => <param>.replace(<escape>)` (arrow, parenthesized or
 *      bare single param) — this is also how `feature-hints.ts`'s inline
 *      `.map((token) => token.replace(...))` copy read before its fold, so
 *      an inline arrow callback counts as a "definition" too.
 *
 * It deliberately does NOT flag a bare inline `value.replace(<escape>)`
 * that is not itself a function/arrow body (e.g. `const esc =
 * dep.replace(...)` in `deps-centralization.test.ts`, or the same shape in
 * `scripts/lib/merge-train-lane.mjs`, `scripts/rollup-changelog.mjs`,
 * `scripts/run-all-ts-rules-posthog.mjs`, `scripts/lib/compat-contracts.mjs`,
 * `tests/clients/config-deprecation-registry.test.ts`, and
 * `tests/support/public-surface-drift.ts`): each is a single one-off
 * computation at its own call site, not a copy-pasted HELPER, and
 * `merge-train-lane.mjs` in particular runs in a workflow with no build step
 * before it (`.github/workflows/merge-train-lane.yml`), so importing the
 * compiled `clients/string-utils.js` there would break that job. Folding a
 * true one-off into an import trades one inline call for a dependency with
 * no duplication removed; the ladder's step 1 ("does this need to exist")
 * says no.
 *
 * A DIFFERENT character class is a variant, not a copy, and stays out of
 * this sweep's reach on purpose: `clients/file-utils.ts`'s `globToRegExp`
 * omits `*` and `?` from the escaped set because its caller handles those
 * two glob wildcards itself immediately afterward.
 *
 * Uses `stripSource(..., { strings: "keep" })` (`tests/support/sweep-kit.ts`)
 * so comments are blanked (a fake definition written only in a comment must
 * not count — the #1635/#1692 comment-laundering shape) while regex literals
 * and string contents are preserved (the default "blank" policy blanks
 * regex bodies too, which would erase the very escape sequence this sweep
 * matches on).
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertNonEmptyScan,
	listSourceFiles,
	relativePosix,
	stripSource,
} from "../support/sweep-kit.js";

const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/** The one file allowed to define the escaping body. */
const CANONICAL_FILE = "clients/string-utils.ts";

// The literal idiom, as it appears in source: `.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")`
// (quote style may vary; whitespace around the comma may vary).
const ESCAPE_CALL = String.raw`\.replace\(\s*\/\[\.\*\+\?\^\$\{\}\(\)\|\[\\\]\\\\\]\/g\s*,\s*["'\`]\\\\\$&["'\`]\s*\)`;

/** Shape A: a function declaration/expression whose body returns the escape. */
const FUNCTION_SHAPE = new RegExp(
	String.raw`function\s+[A-Za-z_$][\w$]*\s*\([^)]*\)[^{]*\{\s*return\s+[A-Za-z_$][\w$]*` +
		ESCAPE_CALL +
		String.raw`\s*;?\s*\}`,
);

/** Shape B: an arrow function (parenthesized or bare single param) whose
 * expression body is the escape — including an inline callback such as
 * `.map((token) => token.replace(...))`. */
const ARROW_SHAPE = new RegExp(
	String.raw`(?:\(\s*[A-Za-z_$][\w$]*[^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[\w$]+)?\s*=>\s*[A-Za-z_$][\w$]*` +
		ESCAPE_CALL,
);

function listCandidateFiles(): string[] {
	const files: string[] = [];
	for (const dir of ["clients", "tools", "mcp", "tests"]) {
		const abs = path.join(root, dir);
		try {
			files.push(
				...listSourceFiles(abs, {
					extensions: [".ts"],
					skipDeclarations: true,
				}),
			);
		} catch {
			// directory doesn't exist in this checkout; nothing to scan
		}
	}
	return files;
}

describe("escapeRegExp single-source-of-truth (#2558)", () => {
	it("has no local escaping-helper definition outside the canonical leaf", () => {
		const files = listCandidateFiles();
		assertNonEmptyScan("clients/tools/mcp/tests source files", files.length);

		const offenders: string[] = [];
		for (const file of files) {
			const rel = relativePosix(root, file);
			if (rel === CANONICAL_FILE) continue;
			const raw = readFileSync(file, "utf8");
			const stripped = stripSource(raw, { strings: "keep" });
			if (FUNCTION_SHAPE.test(stripped) || ARROW_SHAPE.test(stripped)) {
				offenders.push(rel);
			}
		}

		expect(
			offenders,
			`new escaping-helper definition(s) found outside ${CANONICAL_FILE} — ` +
				`import { escapeRegExp } from "clients/string-utils.js" ` +
				`(or its tests/support/sweep-kit.js re-export) instead of re-copying ` +
				`the body: ${offenders.join(", ")}`,
		).toEqual([]);
	});

	it("the canonical leaf still defines escapeRegExp with the expected body", () => {
		const src = readFileSync(path.join(root, CANONICAL_FILE), "utf8");
		expect(FUNCTION_SHAPE.test(stripSource(src, { strings: "keep" }))).toBe(
			true,
		);
	});
});
