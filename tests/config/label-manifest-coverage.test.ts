import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "../../clients/deps/js-yaml.js";
import { assertNonEmptyScan } from "../support/sweep-kit.js";

/**
 * `.github/workflows/labels.yml` runs `micnncim/action-label-syncer` with
 * `prune: true`, dispatched on every merge-train post-merge
 * (`repository_dispatch: merge-train-post-merge`), against
 * `.github/labels.yml`. Prune means the manifest is the label set: any live
 * label absent from it is DELETED on the next sync. #2553's manifest never
 * listed `priority:p1`/`p2`/`p3`, so every sync silently stripped the
 * priority label off every open issue (run 34042925533's log, verbatim:
 * "label: priority:p3 deleted from: apmantza/pi-lens", then p1, p2).
 *
 * This sweep is the backstop: it fails loud, before the syncer ever runs,
 * whenever the manifest drops a label one of this repo's own written rules
 * requires to exist.
 */

const REPO_ROOT = resolve(import.meta.dirname, "../..");

interface LabelEntry {
	name: string;
	color?: string;
	description?: string;
}

function readLabelManifest(): { raw: string; labels: LabelEntry[] } {
	const raw = readFileSync(resolve(REPO_ROOT, ".github/labels.yml"), "utf8");
	const labels = yaml.load(raw) as LabelEntry[];
	return { raw, labels };
}

/**
 * The AREA label set AGENTS.md's "Issue triage & labels" section (#1676)
 * documents, read out of AGENTS.md itself rather than hand-copied here — a
 * hand-copied list would be exactly the parallel-registry shape the
 * single-source-of-truth rule forbids, and would silently drift the moment
 * someone adds an area to AGENTS.md's prose without touching this test.
 */
function areaLabelsFromAgentsMd(): string[] {
	const agentsMd = readFileSync(resolve(REPO_ROOT, "AGENTS.md"), "utf8");
	const marker = "**AREA (one or more, color `#0052cc`):**";
	const markerIndex = agentsMd.indexOf(marker);
	if (markerIndex === -1) {
		throw new Error(
			"AGENTS.md's AREA line (#1676, 'Issue triage & labels') was not found " +
				"at the expected marker — did the doc move or get reworded? Update " +
				"this sweep's marker to match.",
		);
	}
	const lineEnd = agentsMd.indexOf("\n", markerIndex);
	const line = agentsMd.slice(
		markerIndex,
		lineEnd === -1 ? undefined : lineEnd,
	);
	const names = [...line.matchAll(/`(area:[a-z-]+)`/g)].map((m) => m[1]);
	assertNonEmptyScan(
		"label-manifest-coverage: AGENTS.md area labels",
		names.length,
	);
	return names;
}

/**
 * Every label name this repo's own written rules require to exist, beyond
 * the AREA set: the three priority labels (#1676's rubric — deleted and
 * restored once already, #2553), and the merge-train warden's labels
 * (`.claude/skills/merge-train/SKILL.md`, `AGENTS.md`'s merge-train section).
 */
const REQUIRED_NON_AREA_LABELS = [
	"priority:p1",
	"priority:p2",
	"priority:p3",
	"train:approved",
	"train:squash",
	"red-ci",
	"conflict",
] as const;

describe("label manifest coverage (#2553)", () => {
	it("contains every label this repo's rules require to exist", () => {
		const { labels } = readLabelManifest();
		assertNonEmptyScan(
			"label-manifest-coverage: manifest entries",
			labels.length,
		);
		const names = new Set(labels.map((l) => l.name));

		const required = [...REQUIRED_NON_AREA_LABELS, ...areaLabelsFromAgentsMd()];
		const missing = required.filter((name) => !names.has(name));

		expect(missing).toEqual([]);
	});

	it("documents the syncer's prune behavior above the priority block", () => {
		const { raw } = readLabelManifest();
		const lines = raw.split("\n");
		const priorityIndex = lines.findIndex((line) =>
			/^-\s*name:\s*priority:p1\s*$/.test(line.trim()),
		);
		expect(priorityIndex).toBeGreaterThan(-1);

		// The documenting comment must sit ABOVE the priority block (so the
		// next person adding a label by hand sees it before they skip this
		// file), and must name both "prune" and the issue that found the gap
		// (#2553) — a comment naming neither is not documentation, just prose.
		const commentBlockAbove = lines
			.slice(0, priorityIndex)
			.filter((line) => /^\s*#/.test(line));
		const commentText = commentBlockAbove.join("\n");
		expect(commentText).toMatch(/prune/i);
		expect(commentText).toMatch(/#2553/);
	});
});
