/**
 * Resolves the skills directory the `resources_discover` handler (#205)
 * registers, and reports the one condition that yields zero skills with NO
 * visible signal: `<packageRoot>/skills` is absent, unreadable, or holds no
 * `SKILL.md` (#2626).
 *
 * `resolvePackagePath(import.meta.url, "skills")` (`clients/package-root.ts`)
 * is correct for both the source and compiled `dist/` layouts — it walks up
 * from the loaded entry file to the nearest `package.json`. It goes wrong
 * silently, not loudly, when that walk lands somewhere with no `skills/`
 * beside it: `skills/` missing from an installed package, or the entry file
 * copied out of the package tree by a managed extension cache so the nearest
 * `package.json` is the cache's own. Either way `resources_discover` used to
 * hand pi a path that does not exist, `pi` registered zero skills, and
 * nothing — no extension error, no stderr line — said so (investigated on
 * #2587, tracked as #2626).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	getDegradationSummary,
	recordDegradationOnce,
} from "./degradation-ledger.js";
import { getPackageRoot } from "./package-root.js";
import { notifyUserDegradation } from "./user-notify.js";

/** The ledger kind this module records under (`clients/degradation-ledger.ts`). */
const SKILLS_DIR_MISSING_KIND = "skills-dir-missing";

/**
 * True when `dir` holds at least one `SKILL.md` one level down — the shipped
 * layout is `skills/<name>/SKILL.md`. Fail-closed: `fs.readdirSync` throwing
 * for ANY reason — `ENOENT` (absent) or `EACCES` (unreadable) alike — is
 * caught here and treated the same as "no skills here", never propagated out
 * of the handler (`fs.existsSync` itself never throws, per Node's own
 * contract, so no second catch is needed around it).
 */
function hasSkillFile(dir: string): boolean {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return false;
	}
	return entries.some(
		(entry) =>
			entry.isDirectory() &&
			fs.existsSync(path.join(dir, entry.name, "SKILL.md")),
	);
}

/**
 * Resolve the skill paths for `resources_discover`. Returns `[skillsDir]`
 * when it holds at least one `SKILL.md`; returns `[]` and records ONE
 * bounded degradation (`recordDegradationOnce`, reset with the rest of the
 * ledger at `session_start` — the same session-scoped-latch shape as every
 * other once-per-session ledger entry, never a hand-rolled module `Set`)
 * otherwise, so a copy that ships zero skills is visible instead of reading
 * as clean.
 */
export function resolveSkillPaths(importMetaUrl: string): string[] {
	const packageRoot = getPackageRoot(importMetaUrl);
	const skillsDir = path.join(packageRoot, "skills");
	if (hasSkillFile(skillsDir)) return [skillsDir];

	// `import.meta.url` is a runtime-supplied file URL — `getPackageRoot` above
	// already parses it unguarded, so no separate try/catch is added here.
	const entryDir = path.dirname(fileURLToPath(importMetaUrl));
	const reason = `no SKILL.md under ${skillsDir} (entry loaded from ${entryDir})`;

	// The human-facing notify must fire at most once per subject, same as the
	// durable ledger row — a `resources_discover` re-fire within a session must
	// not re-nag. `recordDegradationOnce`'s own once-per-(kind,subject) latch
	// is private state inside the ledger, so the rising edge is read off the
	// ledger's own public summary (single source of truth, catalog shape 17 —
	// no parallel hand-rolled `Set` shadowing it) BEFORE recording.
	const alreadyRecorded = getDegradationSummary()
		.find((group) => group.kind === SKILLS_DIR_MISSING_KIND)
		?.latestReasons.some((entry) => entry.subject === skillsDir);

	recordDegradationOnce({
		kind: SKILLS_DIR_MISSING_KIND,
		subject: skillsDir,
		reason,
	});
	if (!alreadyRecorded) {
		notifyUserDegradation(
			`pi-lens: registers zero skills — ${reason}.`,
			"warning",
		);
	}
	return [];
}
