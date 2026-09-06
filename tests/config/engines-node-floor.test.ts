import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { describe, expect, it } from "vitest";

// #2633: package.json declared no `engines`, so a fresh install silently
// warned EBADENGINE about a transitive package (typescript-language-server)
// instead of pi-lens stating its own Node floor. This governance test keeps
// engines.node present AND honest against every production dependency's own
// declared floor, read from the lockfile (the source of truth for what
// actually gets installed), not re-derived by hand.

const root = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

const pkg = JSON.parse(
	fs.readFileSync(path.join(root, "package.json"), "utf8"),
) as {
	engines?: { node?: string };
};

interface LockPackageEntry {
	dev?: boolean;
	engines?: { node?: string };
	version?: string;
}

const lock = JSON.parse(
	fs.readFileSync(path.join(root, "package-lock.json"), "utf8"),
) as {
	packages?: Record<string, LockPackageEntry>;
};

// A "production" entry is one npm actually installs for a consumer running
// `npm install --omit=dev` — dev:false or the field absent entirely. Walking
// the lock (not package.json's own dependencies/optionalDependencies) covers
// the full transitive closure, not just pi-lens's direct dependencies.
function productionDependenciesWithNodeFloor(): Array<{
	name: string;
	range: string;
}> {
	const packages = lock.packages ?? {};
	const out: Array<{ name: string; range: string }> = [];
	for (const [key, entry] of Object.entries(packages)) {
		if (key === "") continue; // the root package (pi-lens itself)
		if (entry.dev) continue;
		const range = entry.engines?.node;
		if (!range) continue;
		out.push({ name: key, range });
	}
	return out;
}

describe("engines.node floor governance (#2633)", () => {
	it("declares engines.node with a real, finite lower bound", () => {
		const range = pkg.engines?.node;
		expect(range, "package.json must declare engines.node").toBeTruthy();

		// The cheapest way to pass a naive "our range satisfies every
		// dependency's range" check is to declare engines.node: "*" — a
		// wildcard is a semver superset of any finite range, so it would
		// trivially satisfy the subset check below without promising a
		// floor at all. Reject any range whose lower bound is not a real
		// version above 0.0.0.
		const minVersion = semver.minVersion(range ?? "");
		expect(
			minVersion,
			`engines.node ("${range}") must parse to a finite lower bound`,
		).not.toBeNull();
		expect(
			minVersion?.compare("0.0.0"),
			`engines.node ("${range}") must not be an unbounded range like "*"`,
		).toBeGreaterThan(0);
	});

	it("satisfies engines.node for every production dependency's own floor", () => {
		const range = pkg.engines?.node ?? "";
		const deps = productionDependenciesWithNodeFloor();

		// Sanity: the walk must actually find entries, or the check below
		// passes vacuously because there is nothing to violate.
		expect(deps.length).toBeGreaterThan(0);

		// semver.subset(A, B) is true only when every version satisfying A
		// also satisfies B — the correct comparison for disjoint/gapped
		// dependency ranges (e.g. "18 || 20 || >=22"), unlike comparing bare
		// lower bounds, which would miss a gap above the floor.
		const violations = deps.filter((dep) => !semver.subset(range, dep.range));
		expect(
			violations,
			`engines.node ("${range}") must satisfy every production dependency's own engines.node; violations: ${JSON.stringify(violations)}`,
		).toEqual([]);
	});
});
