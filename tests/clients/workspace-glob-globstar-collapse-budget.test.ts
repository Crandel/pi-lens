// flake-shape: elapsed-time-assertion — the defect under test IS wall-clock.
// Adjacent `**` components each emitted their own nullable `(?:.+/)?` group,
// so N of them backtracked 2^N ways against a long non-matching path; the
// answer was always correct, only the time was wrong, so no non-clock
// assertion can distinguish fixed from broken. A mocked clock is by
// construction unfaithful here — it would measure nothing.

/**
 * #2591 review round 2, F1 — bounded-time pin for globstar collapse.
 *
 * `matchesWorkspaceMemberPattern` compiles a workspace-member glob to one
 * anchored regex. Before the fix each `**` component emitted its own
 * `(?:.+/)?`; N adjacent nullable `.+` groups explore 2^N splits of the
 * subject before failing. Upstream `glob` does not have this shape because it
 * collapses consecutive recursive wildcards
 * (`rust-lang/glob@cfa2a58f2e44373573f657ec25b3621e44714dee`,
 * `src/lib.rs:672-684`, "collapse consecutive AnyRecursiveSequence to a single
 * one"), and neither does minimatch, which stayed flat at ~0.2ms across the
 * whole range.
 *
 * Measured through `detectPythonEnvironment` on this box, 21-component path:
 *
 *   chained `**` |  before  |  after
 *   -------------+----------+--------
 *              8 |    69 ms | 0.7 ms
 *             10 |   701 ms | 1.2 ms
 *             12 |  5739 ms | 1.7 ms
 *
 * The budget is asserted through the PRODUCTION path, not the matcher, because
 * that is where the cost is unbounded: `detectPythonEnvironment` is awaited
 * with no timeout by `clients/test-runner-client.ts`,
 * `clients/dispatch/runners/pyright.ts` and `clients/lsp/server.ts`, so a
 * multi-second match is a wedged turn rather than a slow answer.
 *
 * Budget choice (AGENTS.md "loose bound" screen, applied in both directions):
 * 250ms sits 23x below the 5739ms pre-fix cost — decisive as a red — and 147x
 * above the 1.7ms post-fix cost, which is the margin this file buys with its
 * seat in the fully serialized `wall-clock-budget` lane.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { detectPythonEnvironment } from "../../clients/python-environment.js";

/** Deep enough that 2^N splits are astronomically expensive, shallow enough to build fast. */
const PATH_COMPONENTS = 21;
/** The chain length whose pre-fix cost was 5739ms. */
const CHAINED_GLOBSTARS = 12;
const BUDGET_MS = 250;

const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

describe("workspace-member globstar collapse (#2591 review round 2, F1)", () => {
	it(`resolves a ${CHAINED_GLOBSTARS}-deep \`**\` chain within ${BUDGET_MS}ms through detectPythonEnvironment`, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-globstar-"));
		tempDirs.push(root);
		const components = Array.from(
			{ length: PATH_COMPONENTS },
			(_, i) => `d${i}`,
		);
		const nested = path.join(root, ...components);
		fs.mkdirSync(nested, { recursive: true });
		fs.writeFileSync(
			path.join(nested, "pyproject.toml"),
			"[project]\nname='nested'\n",
		);
		// The member glob cannot match (no component is `zzz`), so the regex
		// must exhaust every split before answering — the worst case, and the
		// one a workspace with a deep tree and a typo'd member entry hits.
		fs.writeFileSync(
			path.join(root, "pyproject.toml"),
			`[tool.uv.workspace]\nmembers = ['${Array(CHAINED_GLOBSTARS)
				.fill("**")
				.join("/")}/zzz']\n`,
		);

		// A SIBLING of the tree, never a parent of it: `findUvWorkspace` stops
		// its walk at or above `homeDir`, so a homeDir inside `root` would halt
		// the climb before `<root>/pyproject.toml` is ever read and the matcher
		// would never run — the budget would then pass on broken code. Proven,
		// not assumed: the first version of this test did exactly that and
		// stayed GREEN against the pre-fix compiler (AGENTS.md shape 38).
		const homeDir = path.join(os.tmpdir(), "pi-lens-globstar-absent-home");
		const started = performance.now();
		const environment = await detectPythonEnvironment(nested, homeDir);
		const elapsed = performance.now() - started;

		// The ANSWER was never wrong — assert it too, so a "fix" that made the
		// match cheap by making it incorrect cannot pass this file.
		expect(environment).toBeUndefined();
		expect(elapsed).toBeLessThan(BUDGET_MS);
	});
});
