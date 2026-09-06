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

async function resolvesOnNpmRegistry(bareName: string): Promise<{
	ok: boolean;
	status: number;
}> {
	const res = await fetch(
		`https://registry.npmjs.org/${registryPath(bareName)}`,
		{ method: "GET" },
	);
	return { ok: res.status === 200, status: res.status };
}

describe.skipIf(!RUN_LIVE_REGISTRY_RESOLVE)(
	"managed npm tool packages resolve on the real registry (#2638)",
	() => {
		const npmTools = TOOLS.filter((t) => t.installStrategy === "npm");

		it("registry has at least one npm-strategy tool to check (sanity)", () => {
			expect(npmTools.length).toBeGreaterThan(0);
		});

		for (const tool of npmTools) {
			const bareName = bareNpmName(tool.packageName as string);
			it(`${tool.id} (${bareName}) resolves on npmjs.org`, async () => {
				const result = await resolvesOnNpmRegistry(bareName);
				expect(
					result.ok,
					`${tool.id}: package "${bareName}" returned HTTP ${result.status} from the npm registry — the TOOLS entry names a dead/unpublished package and ensureTool() for this id can never succeed`,
				).toBe(true);
			});
		}
	},
);
