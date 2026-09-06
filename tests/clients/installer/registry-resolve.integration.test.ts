import { describe, expect, it } from "vitest";
import { TOOLS, parsePinnedVersion } from "../../../clients/installer/index.js";

/**
 * #2638: `vscode-css-languageserver` (the bare npm package this id's
 * `packageName` used to name) was unpublished from the registry in 2021 —
 * `ensureTool` for that id could never succeed, and nothing in the suite
 * noticed because every other check on `TOOLS` is network-free (by design,
 * per `tool-registry-consistency.test.ts`'s own doc comment) and so cannot
 * tell "a syntactically fine package name" from "a dead one".
 *
 * This is the missing net: every `installStrategy: "npm"` entry's bare
 * package name (the pin stripped, if any — `parsePinnedVersion` is the
 * production function that already knows how to strip it) must resolve on
 * the real npm registry. Gated behind `PI_LENS_INTEGRATION=1` like the other
 * live-network suites (`typescript-classic-repair.integration.test.ts`,
 * `typescript-native-vitest.integration.test.ts`) — it hits the network and
 * has no place in the default per-PR run; a nightly/tool-smoke lane opts in
 * via the env var.
 */
const RUN_LIVE_REGISTRY_RESOLVE = process.env.PI_LENS_INTEGRATION === "1";

function bareNpmName(packageName: string): string {
	const pinned = parsePinnedVersion(packageName);
	return pinned === undefined
		? packageName
		: packageName.slice(0, packageName.lastIndexOf("@"));
}

/**
 * npm's registry path-encodes a scoped package's `/` (not its leading `@`):
 * `@scope/name` -> `/@scope%2Fname`. A bare name has no `/` to encode.
 */
function registryPath(bareName: string): string {
	if (bareName.startsWith("@")) {
		const slash = bareName.indexOf("/");
		return `${bareName.slice(0, slash)}%2F${bareName.slice(slash + 1)}`;
	}
	return encodeURIComponent(bareName);
}

/**
 * A GET on both a genuinely-unknown name (HTTP 404, body `{"error":"Not
 * found"}`) AND an unpublished package's doc (HTTP 200, a name-squat-
 * prevention stub with `time.unpublished` set) come back as valid JSON
 * with no `dist-tags` — verified live for both
 * `pi-lens-definitely-does-not-exist-2638` and the exact dead package
 * #2638 shipped, `vscode-css-languageserver`. `npm install`/`npm view`
 * resolve through `dist-tags.latest`, so checking THAT (rather than the
 * HTTP status, which a mutation probe showed never independently
 * distinguishes these two failure shapes from a real install) is the one
 * signal this helper needs; a non-JSON body is a genuine registry/network
 * failure and is left to throw and fail the test loudly rather than being
 * swallowed into a soft "not ok".
 */
async function resolvesOnNpmRegistry(bareName: string): Promise<{
	ok: boolean;
	status: number;
	detail: string;
}> {
	const res = await fetch(
		`https://registry.npmjs.org/${registryPath(bareName)}`,
		{ method: "GET" },
	);
	const body = (await res.json()) as {
		"dist-tags"?: Record<string, string>;
		time?: { unpublished?: unknown };
	};
	const latest = body["dist-tags"]?.latest;
	if (!latest) {
		return {
			ok: false,
			status: res.status,
			detail: body.time?.unpublished
				? `unpublished (HTTP ${res.status}, no dist-tags.latest)`
				: `no dist-tags.latest (HTTP ${res.status})`,
		};
	}
	return { ok: true, status: res.status, detail: `latest=${latest}` };
}

describe.skipIf(!RUN_LIVE_REGISTRY_RESOLVE)(
	"managed npm tool packages resolve on the real registry (#2638)",
	() => {
		const npmTools = TOOLS.filter((t) => t.installStrategy === "npm");

		it("registry has at least one npm-strategy tool to check (sanity)", () => {
			expect(npmTools.length).toBeGreaterThan(0);
		});

		// Nothing in the TOOLS registry today is a genuinely nonexistent name
		// (only #2638's real regression, an unpublished-but-once-real name), so
		// the helper's rejection of a plain 404 is proven directly here rather
		// than left unverified.
		it("resolvesOnNpmRegistry rejects a genuinely nonexistent package name (HTTP 404 branch)", async () => {
			const result = await resolvesOnNpmRegistry(
				"pi-lens-definitely-does-not-exist-2638",
			);
			expect(result.ok).toBe(false);
			expect(result.status).toBe(404);
		});

		it("resolvesOnNpmRegistry rejects the historically-dead #2638 package name directly", async () => {
			const result = await resolvesOnNpmRegistry("vscode-css-languageserver");
			expect(result.ok).toBe(false);
			expect(result.detail).toContain("unpublished");
		});

		for (const tool of npmTools) {
			const bareName = bareNpmName(tool.packageName as string);
			it(`${tool.id} (${bareName}) resolves on npmjs.org`, async () => {
				const result = await resolvesOnNpmRegistry(bareName);
				expect(
					result.ok,
					`${tool.id}: package "${bareName}" is not installable (${result.detail}) — the TOOLS entry names a dead/unpublished package and ensureTool() for this id can never succeed`,
				).toBe(true);
			});
		}
	},
);
