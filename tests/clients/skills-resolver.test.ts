import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import { resolveSkillPaths } from "../../clients/skills-resolver.js";
import {
	resetUserNotifier,
	wireUserNotifier,
} from "../../clients/user-notify.js";

/**
 * #2626: `resources_discover` (#205) resolves `<packageRoot>/skills` and
 * registers whatever it finds. When that directory is absent, unreadable, or
 * holds no `SKILL.md`, pi previously registered zero skills with NO extension
 * error and empty stderr — completely silent (investigated on #2587).
 *
 * `resolveSkillPaths` IS the function the real `resources_discover` handler
 * calls (`index.ts` now does `skillPaths: resolveSkillPaths(import.meta.url)`
 * verbatim) — these tests drive it directly with synthetic `file://` URLs
 * built over real temp directories (real `fs.existsSync`/`readdirSync` walk,
 * no mocked filesystem) rather than a hand-fed reimplementation of the check.
 *
 * Shape 38 / #2626 review note: `getPackageRoot` (`clients/package-root.ts`)
 * memoizes its walk in a module-level `Map` keyed by the exact
 * `importMetaUrl` string. Reusing the same synthetic URL across scenarios
 * with different on-disk layouts would silently read back an earlier
 * scenario's cached root instead of re-walking — the fixture would never
 * reach the code under test a second time. Every scenario below therefore
 * gets its OWN freshly created temp directory (and so its own unique
 * `importMetaUrl`), guaranteeing a real cache miss each time.
 */

const notified: Array<{ message: string; level: string | undefined }> = [];
let tmpDirs: string[] = [];

beforeEach(() => {
	notified.length = 0;
	tmpDirs = [];
	resetDegradationLedger();
	wireUserNotifier(() => (message, level) => {
		notified.push({ message, level });
	});
});

afterEach(() => {
	resetUserNotifier();
	resetDegradationLedger();
	for (const dir of tmpDirs) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

/** A fresh, unique package root under a real temp dir — see the shape-38 note above. */
function freshPackageRoot(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pilens-skills-test-"));
	tmpDirs.push(dir);
	fs.writeFileSync(path.join(dir, "package.json"), "{}");
	return dir;
}

function entryUrl(entryFile: string): string {
	return pathToFileURL(entryFile).href;
}

function skillsDegradationGroup() {
	return getDegradationSummary().find(
		(group) => group.kind === "skills-dir-missing",
	);
}

describe("resolveSkillPaths (#2626)", () => {
	it("layout F: entry copied out of the package (nearest package.json has no skills/) records the degradation", () => {
		// Mirrors the issue's managed-cache layout: <cache>/npm/package.json is
		// the nearest package.json to the relocated entry, and <cache>/npm/skills
		// does not exist.
		const cacheRoot = freshPackageRoot();
		const entryFile = path.join(cacheRoot, "ext", "pi-lens.js");

		const result = resolveSkillPaths(entryUrl(entryFile));

		expect(result).toEqual([]);
		const group = skillsDegradationGroup();
		expect(group?.count).toBe(1);
		const expectedSkillsDir = path.join(cacheRoot, "skills");
		expect(group?.latestReasons.at(-1)?.subject).toBe(expectedSkillsDir);
		expect(group?.latestReasons.at(-1)?.reason).toContain(expectedSkillsDir);
		expect(group?.latestReasons.at(-1)?.reason).toContain(
			path.join(cacheRoot, "ext"),
		);
		expect(notified).toHaveLength(1);
		expect(notified[0]?.level).toBe("warning");
		expect(notified[0]?.message).toContain("pi-lens:");
		expect(notified[0]?.message).toContain(expectedSkillsDir);
	});

	it("standard layout: skills/ beside package.json resolves and records nothing", () => {
		const packageRoot = freshPackageRoot();
		const skillsDir = path.join(packageRoot, "skills", "pi-lens-example");
		fs.mkdirSync(skillsDir, { recursive: true });
		fs.writeFileSync(path.join(skillsDir, "SKILL.md"), "# example skill\n");
		const entryFile = path.join(packageRoot, "dist", "index.js");

		const result = resolveSkillPaths(entryUrl(entryFile));

		expect(result).toEqual([path.join(packageRoot, "skills")]);
		expect(skillsDegradationGroup()).toBeUndefined();
		expect(notified).toHaveLength(0);
	});

	it("skills/ exists but holds no SKILL.md records the degradation", () => {
		const packageRoot = freshPackageRoot();
		// Empty skills/ dir, and a nested non-skill directory — neither yields a
		// SKILL.md at either depth `hasSkillFile` checks.
		fs.mkdirSync(path.join(packageRoot, "skills", "not-a-skill"), {
			recursive: true,
		});
		const entryFile = path.join(packageRoot, "index.js");

		const result = resolveSkillPaths(entryUrl(entryFile));

		expect(result).toEqual([]);
		const group = skillsDegradationGroup();
		expect(group?.count).toBe(1);
		expect(group?.latestReasons.at(-1)?.subject).toBe(
			path.join(packageRoot, "skills"),
		);
		expect(notified).toHaveLength(1);
	});

	it("records the degradation only once per subject (recordDegradationOnce)", () => {
		const cacheRoot = freshPackageRoot();
		const entryFile = path.join(cacheRoot, "ext", "pi-lens.js");

		resolveSkillPaths(entryUrl(entryFile));
		resolveSkillPaths(entryUrl(entryFile));
		resolveSkillPaths(entryUrl(entryFile));

		expect(skillsDegradationGroup()?.count).toBe(1);
		expect(notified).toHaveLength(1);
	});
});
