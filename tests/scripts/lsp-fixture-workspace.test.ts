/**
 * #2670 (folds #2658). `bootstrapFixtureWorkspace`/`withScratchHome`
 * (scripts/lib/lsp-fixture-workspace.mjs) are the shared "copy fixture →
 * register session root → optional disable+reload → optional git init →
 * assert registered" bootstrap for all five LSP dev-harness scripts, plus
 * the PI_LENS_HOME/PILENS_DATA_DIR scratch-home pin (#2506 shape).
 *
 * In-process against the REAL `dist/clients/lsp/config.js` and
 * `dist/clients/lsp/session-roots.js` — not a mock of either — so a real
 * signature drift in the helper's own dependencies is what this file would
 * catch. One in-process pass here covers all five call sites' shared
 * plumbing; `tests/scripts/smoke-tools-lsp-fixture-registration.test.ts`
 * keeps the one real-spawn smoke case that needs an actual CLI process
 * (fixture-ORDER is a whole-process property no in-process call can
 * reproduce).
 *
 * `repoRoot` passed to the helper in these tests is a throwaway temp dir
 * standing in for the real repo — the helper only ever does
 * `fs.cpSync(path.join(repoRoot, fx.dir), workspace, ...)`, so a tiny fake
 * fixture tree is enough and keeps this file independent of the real
 * LSP_FIXTURES set.
 *
 * PI_LENS_HOME/PILENS_DATA_DIR: `tests/support/vitest-setup.ts` already pins
 * PI_LENS_HOME to a per-worker temp dir for every test in this run (#2506).
 * The `withScratchHome` describe block below deliberately unsets it for a
 * few tests to exercise the "nothing pinned yet" branch, and restores it in
 * `afterEach` — never leaving it unset for a later test in this file or
 * worker.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

const tmpDirs: string[] = [];
function freshTmpDir(prefix: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tmpDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tmpDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

describe("bootstrapFixtureWorkspace (#2670/#2658)", () => {
	let bootstrapFixtureWorkspace: (
		fx: Record<string, unknown>,
		opts: Record<string, unknown>,
	) => Promise<{
		workspace: string;
		absFile: string;
		cleanup: () => void;
		disabledServers: string[];
	}>;
	let initLSPConfig: (cwd: string) => Promise<void>;
	let isSessionRootRegistered: (cwd: string) => boolean;
	let resetLSPConfigStateForTests: () => void;
	let fakeRepoRoot: string;

	const fx = { lang: "test-lang", dir: "fx-dir", file: "a.txt" };

	beforeEach(async () => {
		({ bootstrapFixtureWorkspace } = await import(
			pathToFileURL(
				path.join(repoRoot, "scripts", "lib", "lsp-fixture-workspace.mjs"),
			).href
		));
		({ initLSPConfig, resetLSPConfigStateForTests } = await import(
			pathToFileURL(path.join(repoRoot, "dist", "clients", "lsp", "config.js"))
				.href
		));
		({ isSessionRootRegistered } = await import(
			pathToFileURL(
				path.join(repoRoot, "dist", "clients", "lsp", "session-roots.js"),
			).href
		));
		resetLSPConfigStateForTests();
		fakeRepoRoot = freshTmpDir("lsp-fixture-workspace-repo-");
		fs.mkdirSync(path.join(fakeRepoRoot, "fx-dir"));
		fs.writeFileSync(path.join(fakeRepoRoot, "fx-dir", "a.txt"), "hello\n");
	});

	it("copies the fixture, registers the workspace as a session root, and returns workspace/absFile/cleanup", async () => {
		const { workspace, absFile, cleanup } = await bootstrapFixtureWorkspace(
			fx,
			{ initLSPConfig, repoRoot: fakeRepoRoot, tmpPrefix: "test-" },
		);
		expect(fs.existsSync(absFile)).toBe(true);
		expect(fs.readFileSync(absFile, "utf8")).toBe("hello\n");
		expect(isSessionRootRegistered(workspace)).toBe(true);
		cleanup();
		expect(fs.existsSync(workspace)).toBe(false);
	});

	// The whole point of #2369/#2655/#2658: registration must not depend on
	// anything else about the fixture. No `disableServers`, no `gitInit` — the
	// workspace must still be a registered session root.
	it("registers the workspace unconditionally even when nothing else about the fixture requires it", async () => {
		const { workspace } = await bootstrapFixtureWorkspace(fx, {
			initLSPConfig,
			repoRoot: fakeRepoRoot,
			tmpPrefix: "test-",
		});
		expect(isSessionRootRegistered(workspace)).toBe(true);
	});

	it("throws (never silently proceeds) when the caller's initLSPConfig doesn't actually register the workspace", async () => {
		const brokenInitLSPConfig = async () => {
			// simulates a caller wiring bug: doesn't call the real registrar
		};
		await expect(
			bootstrapFixtureWorkspace(fx, {
				initLSPConfig: brokenInitLSPConfig,
				repoRoot: fakeRepoRoot,
				tmpPrefix: "test-",
			}),
		).rejects.toThrow(/#2369\/#2655/);
	});

	it("git-inits the workspace when gitInit is true", async () => {
		const { workspace, cleanup } = await bootstrapFixtureWorkspace(fx, {
			initLSPConfig,
			repoRoot: fakeRepoRoot,
			tmpPrefix: "test-",
			gitInit: true,
		});
		expect(fs.existsSync(path.join(workspace, ".git"))).toBe(true);
		cleanup();
	});

	it("does not git-init when gitInit is omitted and the fixture doesn't request it", async () => {
		const { workspace, cleanup } = await bootstrapFixtureWorkspace(fx, {
			initLSPConfig,
			repoRoot: fakeRepoRoot,
			tmpPrefix: "test-",
		});
		expect(fs.existsSync(path.join(workspace, ".git"))).toBe(false);
		cleanup();
	});

	it("falls back to fx.disableServers when no override is given, writing .pi-lens/lsp.json", async () => {
		const { workspace, disabledServers, cleanup } =
			await bootstrapFixtureWorkspace(
				{ ...fx, disableServers: ["typescript"] },
				{ initLSPConfig, repoRoot: fakeRepoRoot, tmpPrefix: "test-" },
			);
		expect(disabledServers).toEqual(["typescript"]);
		const written = JSON.parse(
			fs.readFileSync(path.join(workspace, ".pi-lens", "lsp.json"), "utf8"),
		);
		expect(written).toEqual({ disabledServers: ["typescript"] });
		cleanup();
	});

	it("writes nothing under .pi-lens when there is nothing to disable", async () => {
		const { workspace, cleanup } = await bootstrapFixtureWorkspace(fx, {
			initLSPConfig,
			repoRoot: fakeRepoRoot,
			tmpPrefix: "test-",
		});
		expect(fs.existsSync(path.join(workspace, ".pi-lens"))).toBe(false);
		cleanup();
	});

	// bench-lsp's (#2658) shape: the disable list depends on servers matching
	// the file INSIDE the just-copied workspace, so it must be computed after
	// copy+register, not passed in as a static list up front.
	it("computes disableServers from a function called AFTER the workspace is copied and registered", async () => {
		const seen: Array<{ workspace: string; absFile: string }> = [];
		const { workspace, absFile, disabledServers, cleanup } =
			await bootstrapFixtureWorkspace(fx, {
				initLSPConfig,
				repoRoot: fakeRepoRoot,
				tmpPrefix: "test-",
				disableServers: (ctx: { workspace: string; absFile: string }) => {
					// The workspace must already exist and be registered by the time
					// this runs — assert both, not just record the call.
					expect(fs.existsSync(ctx.absFile)).toBe(true);
					expect(isSessionRootRegistered(ctx.workspace)).toBe(true);
					seen.push(ctx);
					return ["computed-server"];
				},
			});
		expect(seen).toHaveLength(1);
		expect(seen[0].workspace).toBe(workspace);
		expect(seen[0].absFile).toBe(absFile);
		expect(disabledServers).toEqual(["computed-server"]);
		cleanup();
	});

	it("uses a pre-supplied workspace instead of creating a new one (probe-clean-signal's shape)", async () => {
		const preMade = freshTmpDir("premade-");
		const { workspace } = await bootstrapFixtureWorkspace(fx, {
			initLSPConfig,
			repoRoot: fakeRepoRoot,
			workspace: preMade,
		});
		expect(workspace).toBe(preMade);
		expect(isSessionRootRegistered(preMade)).toBe(true);
	});
});

describe("withScratchHome (#2670/#2506-shape)", () => {
	let withScratchHome: (opts?: { realHome?: boolean; tmpPrefix?: string }) => {
		dir: string | undefined;
		pinned: boolean;
		restore: () => void;
	};
	let savedHome: string | undefined;
	let savedData: string | undefined;

	beforeEach(async () => {
		({ withScratchHome } = await import(
			pathToFileURL(
				path.join(repoRoot, "scripts", "lib", "lsp-fixture-workspace.mjs"),
			).href
		));
		savedHome = process.env.PI_LENS_HOME;
		savedData = process.env.PILENS_DATA_DIR;
	});

	afterEach(() => {
		// Always restore — `tests/support/vitest-setup.ts` pins PI_LENS_HOME for
		// every other test in this worker; leaving it unset would send a later
		// test's writes to the real home (#2506 shape).
		if (savedHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = savedHome;
		if (savedData === undefined) delete process.env.PILENS_DATA_DIR;
		else process.env.PILENS_DATA_DIR = savedData;
	});

	it("pins PI_LENS_HOME and PILENS_DATA_DIR to a fresh temp dir when neither is set", () => {
		delete process.env.PI_LENS_HOME;
		delete process.env.PILENS_DATA_DIR;
		const { dir, pinned, restore } = withScratchHome();
		try {
			expect(pinned).toBe(true);
			expect(dir).toBeTruthy();
			expect(process.env.PI_LENS_HOME).toBe(dir);
			expect(process.env.PILENS_DATA_DIR).toBe(dir);
			expect(fs.existsSync(dir as string)).toBe(true);
		} finally {
			restore();
			fs.rmSync(dir as string, { recursive: true, force: true });
		}
		expect(process.env.PI_LENS_HOME).toBeUndefined();
		expect(process.env.PILENS_DATA_DIR).toBeUndefined();
	});

	it("respects an already-pinned PI_LENS_HOME instead of clobbering the caller's explicit choice", () => {
		process.env.PI_LENS_HOME = "/some/explicit/home";
		delete process.env.PILENS_DATA_DIR;
		const { dir, pinned } = withScratchHome();
		expect(pinned).toBe(false);
		expect(dir).toBe("/some/explicit/home");
		expect(process.env.PI_LENS_HOME).toBe("/some/explicit/home");
		// PILENS_DATA_DIR is untouched when PI_LENS_HOME was already pinned —
		// this call is a pure no-op, not a partial pin.
		expect(process.env.PILENS_DATA_DIR).toBeUndefined();
	});

	it("leaves PILENS_DATA_DIR untouched when the caller already set it explicitly", () => {
		delete process.env.PI_LENS_HOME;
		process.env.PILENS_DATA_DIR = "/some/explicit/data-dir";
		const { dir, restore } = withScratchHome();
		try {
			expect(process.env.PI_LENS_HOME).toBe(dir);
			expect(process.env.PILENS_DATA_DIR).toBe("/some/explicit/data-dir");
		} finally {
			restore();
			fs.rmSync(dir as string, { recursive: true, force: true });
		}
		expect(process.env.PILENS_DATA_DIR).toBe("/some/explicit/data-dir");
	});

	it("does nothing when { realHome: true } is passed", () => {
		delete process.env.PI_LENS_HOME;
		delete process.env.PILENS_DATA_DIR;
		const { dir, pinned } = withScratchHome({ realHome: true });
		expect(pinned).toBe(false);
		expect(dir).toBeUndefined();
		expect(process.env.PI_LENS_HOME).toBeUndefined();
		expect(process.env.PILENS_DATA_DIR).toBeUndefined();
	});
});
