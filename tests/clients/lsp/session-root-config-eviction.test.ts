/**
 * #2518: an operator's LSP denial must not be lifted by traffic to OTHER cwds.
 *
 * The production shape this reproduces is `ensureReady` (`mcp/server.ts:196`):
 * it calls `initLSPConfig` for the cwd of every `pilens_*` tool call, then
 * short-circuits on `shouldInitializeSessionRoot`. Before the fix the config
 * payload lived in a 32-entry cache while the session-root registry held 128,
 * so ~33 foreign cwds evicted a LIVE root's config while the registry still
 * reported it ready — nothing re-initialized it, and `isServerDisabled` (the
 * predicate the runtime gate reads) answered `false` for a server the operator
 * had turned off.
 *
 * Every call below is the production function: the real `initLSPConfig`, the
 * real `shouldInitializeSessionRoot` against a memo shaped exactly like
 * `mcp/server.ts`'s `lspReadyCwds`, and the real denial predicate. No mocks —
 * a double here would only prove the double's own cap.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	initLSPConfig,
	isServerDisabled,
	resetLSPConfigStateForTests,
} from "../../../clients/lsp/config.js";
import {
	isSessionRootRegistered,
	shouldInitializeSessionRoot,
} from "../../../clients/lsp/session-roots.js";
import { removeTempDirSync } from "../test-utils.js";

const DENIED_SERVER = "typos";
const dirs: string[] = [];
let previousHome: string | undefined;

/** A project root whose `.pi-lens.json` denies {@link DENIED_SERVER}. */
function denyingRoot(): string {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2518-deny-")),
	);
	dirs.push(dir);
	fs.writeFileSync(
		path.join(dir, ".pi-lens.json"),
		JSON.stringify({ lsp: { disabledServers: [DENIED_SERVER] } }),
	);
	fs.writeFileSync(path.join(dir, "notes.md"), "# notes\n");
	return dir;
}

/** A foreign cwd — the kind another `pilens_analyze` call names. */
function foreignRoot(index: number): string {
	const dir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), `pi-lens-2518-other-${index}-`)),
	);
	dirs.push(dir);
	return dir;
}

beforeEach(() => {
	previousHome = process.env.PI_LENS_HOME;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-2518-home-"));
	dirs.push(home);
	process.env.PI_LENS_HOME = home;
	resetLSPConfigStateForTests();
	resetDegradationLedger();
});

afterEach(() => {
	resetLSPConfigStateForTests();
	resetDegradationLedger();
	if (previousHome === undefined) delete process.env.PI_LENS_HOME;
	else process.env.PI_LENS_HOME = previousHome;
	for (const dir of dirs.splice(0)) removeTempDirSync(dir);
});

describe("#2518 a live session root's denial survives foreign cwd traffic", () => {
	it("keeps the operator's denial after 40 other cwds pass through ensureReady", async () => {
		const root = denyingRoot();
		const file = path.join(root, "notes.md");
		// `mcp/server.ts`'s `lspReadyCwds`: the readiness memo `ensureReady`
		// consults before it re-initializes anything.
		const readyCwds = new Set<string>();

		await initLSPConfig(root);
		readyCwds.add(root);
		expect(isServerDisabled(DENIED_SERVER, file)).toBe(true);

		// The reviewer's probe from the issue: ~40 `ensureReady` calls naming
		// OTHER directories, each one a legitimate `pilens_analyze` /
		// `pilens_diagnostics` invocation.
		for (let index = 0; index < 40; index++) {
			const other = foreignRoot(index);
			await initLSPConfig(other);
			readyCwds.add(other);
		}

		// The root is still served, so `ensureReady` returns early and NOTHING
		// re-initializes it — which is why the config below must still be there.
		expect(isSessionRootRegistered(root)).toBe(true);
		expect(shouldInitializeSessionRoot(root, readyCwds)).toBe(false);
		expect(isServerDisabled(DENIED_SERVER, file)).toBe(true);
	}, 60_000);

	it("serves a config for exactly the roots the registry still serves", async () => {
		// The structural coupling, stated over the whole population: a root is
		// registered if and only if its denial still applies. Past the cap the
		// oldest roots ARE dropped — that is the designed bound — but they are
		// dropped from BOTH answers at once, so `shouldInitializeSessionRoot`
		// sends the next caller back through `initLSPConfig` for exactly the
		// roots whose denial is no longer loaded.
		const roots = Array.from({ length: 130 }, () => denyingRoot());
		for (const root of roots) await initLSPConfig(root);

		const decoupled = roots.filter(
			(root) =>
				isSessionRootRegistered(root) !==
				isServerDisabled(DENIED_SERVER, path.join(root, "notes.md")),
		);
		expect(decoupled).toEqual([]);
	}, 120_000);

	it("keeps a served root's denial applied while it re-initializes", async () => {
		const root = denyingRoot();
		const file = path.join(root, "notes.md");
		await initLSPConfig(root);

		// A second session declaring the same root. `initLSPConfig` re-registers
		// it synchronously, before its loader await — so a registration that
		// overwrote the stored config with the "not loaded yet" placeholder would
		// blank this live root's denial for the length of the load.
		const reinit = initLSPConfig(root);
		expect(isServerDisabled(DENIED_SERVER, file)).toBe(true);
		await reinit;
		expect(isServerDisabled(DENIED_SERVER, file)).toBe(true);
	}, 60_000);

	it("applies an ancestor root's denial while a nested root is still loading", async () => {
		const parent = denyingRoot();
		const child = path.join(parent, "sub");
		fs.mkdirSync(child);
		fs.writeFileSync(path.join(child, "notes.md"), "# nested\n");
		await initLSPConfig(parent);

		// The nested root is registered but has no config until its load
		// settles. That in-flight entry must not shadow the ancestor whose
		// config IS loaded: pre-#2518 the store simply had no entry for it, and
		// the longest-prefix walk fell through to the parent. It still must.
		const loading = initLSPConfig(child);
		expect(isServerDisabled(DENIED_SERVER, path.join(child, "notes.md"))).toBe(
			true,
		);
		await loading;
	}, 60_000);

	it("records one bounded degradation when the cap drops a served root", async () => {
		for (let index = 0; index < 130; index++) {
			await initLSPConfig(foreignRoot(index));
		}

		const evictions = getDegradationSummary().filter(
			(group) => group.kind === "lsp-session-root-evicted",
		);
		expect(evictions).toHaveLength(1);
		// Bounded: two evictions happened above, one row was written.
		expect(evictions[0]?.latestReasons).toHaveLength(1);
	}, 120_000);
});
