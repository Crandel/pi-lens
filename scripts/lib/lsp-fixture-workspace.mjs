import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gitExecFileSync } from "./git-fixture-env.mjs";
import { assertFixtureWorkspaceRegistered } from "./lsp-fixture-session-guard.mjs";
import { safeRm } from "./safe-rm.mjs";

/**
 * #2670 (folds #2658). The one "copy fixture → register session root →
 * optional `.pi-lens/lsp.json` disable + reload → optional `git init` →
 * assert registered" bootstrap every LSP dev-harness script needs, shared
 * instead of hand-copied. Before this module, `characterize-lsp.mjs` and
 * `server-capabilities.mjs` carried a byte-identical 23-line block,
 * `probe-clean-signal.mjs` the same shape with two flags read from different
 * local names, `smoke-tools.mjs` its own (order-shifted, `fx.setup`/
 * `fx.lombokJar` interleaved) variant, and `bench-lsp.mjs` (#2658) skipped
 * the unconditional register entirely — the exact #2369/#2655 ordering bug,
 * a fifth time.
 *
 * `initLSPConfig` is caller-supplied rather than imported here: each script
 * loads it from a slightly different `dist/` entry point (some via a
 * top-level `await import()`, smoke-tools.mjs from inside a function), and
 * this module has no opinion on that — see lsp-fixture-session-guard.mjs's
 * own doc comment for the identical reasoning about not importing
 * `initLSPConfig` itself.
 *
 * `disableServers`:
 *   - omitted → falls back to `fx.disableServers` (a fixture's own static
 *     list), matching every caller except bench-lsp.
 *   - an array → an explicit override.
 *   - a function `({ workspace, absFile, fx }) => string[]` → computed AFTER
 *     the workspace exists and is registered but BEFORE anything is
 *     disabled — bench-lsp's shape: it disables whatever
 *     `getServersForFileWithConfig(absFile)` returns that isn't this
 *     fixture's measurement target, which needs a real file path inside a
 *     real (already-copied) workspace to compute.
 *
 * `workspace`, when given, is used as-is instead of a fresh `mkdtempSync` —
 * probe-clean-signal.mjs pre-creates its temp dir outside this call so its
 * own `withTimeout` wrapper and `finally` cleanup can own it start to finish
 * even if bootstrapping itself times out.
 *
 * Returns `{ workspace, absFile, cleanup, disabledServers }` — `cleanup()`
 * removes the workspace (Windows-safe retry, matching smoke-tools.mjs's
 * existing `safeRm`); a caller that pre-supplied `workspace` and owns its
 * own cleanup is free to ignore it.
 */
export async function bootstrapFixtureWorkspace(fx, opts) {
	const {
		initLSPConfig,
		repoRoot,
		tmpPrefix = "lsp-fixture-",
		workspace: preMadeWorkspace,
		gitInit = fx.gitInit,
		disableServers,
	} = opts;

	const workspace =
		preMadeWorkspace ?? fs.mkdtempSync(path.join(os.tmpdir(), tmpPrefix));
	fs.cpSync(path.join(repoRoot, fx.dir), workspace, { recursive: true });

	// #2369/#2655/#2658: every fixture registers its OWN workspace
	// unconditionally — never only inside the `disableServers` branch below.
	// `clients/lsp/session-roots.ts` fails OPEN (declines nothing) only while
	// its registry is empty; the moment ANY fixture registers its own
	// workspace, every OTHER still-unregistered workspace is silently
	// declined. See lsp-fixture-session-guard.mjs for the full writeup.
	await initLSPConfig(workspace);
	const absFile = path.join(workspace, fx.file);

	if (gitInit) {
		try {
			gitExecFileSync(["init", "-q"], { cwd: workspace, stdio: "ignore" });
		} catch {
			// git unavailable — caller-specific fallback behavior is unaffected
		}
	}

	const resolvedDisable =
		typeof disableServers === "function"
			? disableServers({ workspace, absFile, fx })
			: (disableServers ?? fx.disableServers);

	if (resolvedDisable && resolvedDisable.length) {
		fs.mkdirSync(path.join(workspace, ".pi-lens"), { recursive: true });
		fs.writeFileSync(
			path.join(workspace, ".pi-lens", "lsp.json"),
			JSON.stringify({ disabledServers: resolvedDisable }, null, 2),
		);
		// The disabled-server list must land in the CACHED config, so reload
		// after writing it — the early call above exists only for session-root
		// registration, which `initLSPConfig` performs before touching disk.
		await initLSPConfig(workspace);
	}

	// Harness guard (#2369/#2655/#2658): every fixture must register its own
	// workspace as a session root before it is touched.
	await assertFixtureWorkspaceRegistered(fx.lang, workspace);

	const cleanup = () => safeRm(workspace);

	return {
		workspace,
		absFile,
		cleanup,
		disabledServers: resolvedDisable ?? [],
	};
}

/**
 * #2670/#2506-shape. The four sibling scripts' now-unconditional
 * `initLSPConfig` (and smoke-tools.mjs's own) each emit a
 * `config_resolution_pending` + `config_resolved` pair per fixture — 49 on a
 * full `--lsp` run, up from 3 pre-#2369 — into whatever `~/.pi-lens/
 * latency.log`/`sessionstart.log` `getGlobalPiLensLogDir()`/
 * `getGlobalPiLensDir()` resolve to. Both resolve from `PI_LENS_HOME`
 * FIRST, before any other fallback (`clients/file-utils.ts`,
 * `clients/probe-home-state.ts`) — so pinning that one env var (plus its
 * project-scoped sibling `PILENS_DATA_DIR`) is sufficient, and must happen
 * before the first `dist/` import: `dist/clients/latency-logger.js` reads
 * its log directory into a top-level `const` at module load, not lazily
 * per write.
 *
 * Pins only when the caller hasn't already chosen a home (an explicit
 * `PI_LENS_HOME` — set by an operator, a wrapper script, or a test spawning
 * one of these harness scripts as a child — always wins, matching
 * `getGlobalPiLensLogDir()`'s own "PI_LENS_HOME wins over any redirect"
 * contract instead of silently clobbering it). Pass `{ realHome: true }`
 * (with a comment explaining why) to skip pinning even when unset — no
 * caller in this repo does today.
 *
 * Deliberately a FRESH directory per call (an actual "per-run" scratch
 * home, matching what the caller asked for), not a stable one reused across
 * invocations: a stable global path would let concurrent scripts/agents on
 * the same machine race on one `instances.json`/tool tree. The cost is that
 * `--install` runs of these scripts no longer share a tool cache ACROSS
 * separate script invocations (each of the five nightly steps installs its
 * own copy) — acceptable for a nightly, manual-dispatch harness whose
 * runner is itself thrown away every night; see the PR body for the
 * tradeoff this was weighed against.
 */
const SCRATCH_HOME_OWNER_FILE = "owner.pid";
// Fallback for a dir with no pid file at all (pre-dates this fix, or its
// writer crashed between mkdtemp and writing its own pid) — old enough that
// ANY normal `--install` run (minutes, not hours) is long finished, so this
// never races a live one.
const SCRATCH_HOME_ORPHAN_AGE_MS = 60 * 60 * 1000; // 1h

/**
 * Is the process that minted `entryDir` (its recorded `owner.pid`) still
 * alive? `undefined` when there's no pid file to check (caller falls back to
 * an age gate). `process.kill(pid, 0)` sends no signal — it only probes
 * existence/permission: `ESRCH` means no such process (dead); anything else
 * (success, or `EPERM` — a live process this one merely lacks permission to
 * signal) means a real, live process still owns this dir.
 */
function scratchHomeOwnerAlive(entryDir) {
	let pidText;
	try {
		pidText = fs.readFileSync(
			path.join(entryDir, SCRATCH_HOME_OWNER_FILE),
			"utf8",
		);
	} catch {
		return undefined; // no pid file recorded
	}
	const pid = Number.parseInt(pidText.trim(), 10);
	if (!Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err?.code !== "ESRCH";
	}
}

/**
 * Sweep leftover scratch-home dirs from PRIOR runs (#2670 review F2, hardened
 * in review round 2 F1). Nothing else ever removes a scratch home:
 * `withScratchHome`'s `restore()` only unsets the env vars (the dir itself
 * may still hold installed tools a LATER call in the same process wants to
 * keep using), and a SIGKILL'd run skips any exit handler entirely — without
 * this sweep, every `--install` run leaves a full tool tree behind in
 * `os.tmpdir()` forever.
 *
 * NOT a blind "try rmSync, catch = still locked" pass (round 1's shape,
 * reviewer round 2 F1): on POSIX, `rmSync` on a directory another process is
 * actively using SUCCEEDS regardless — only Windows EPERMs on an open
 * handle — so that catch block was describing a protection that did not
 * exist. A live writer whose scratch home got removed out from under it
 * would keep appending to files by then-unlinked inode: silent, permanent
 * data loss, not a caught-and-skipped no-op. Liveness is checked for real
 * instead: each dir's `owner.pid` (written at mint by `withScratchHome`)
 * against `process.kill(pid, 0)` — alive is skipped unconditionally, dead is
 * removed. A dir with no pid file at all only goes by age (see
 * `SCRATCH_HOME_ORPHAN_AGE_MS`), never by whether `rmSync` happens to throw.
 */
function sweepScratchHomeLeftovers(tmpPrefix) {
	let entries;
	const tmp = os.tmpdir();
	try {
		entries = fs.readdirSync(tmp);
	} catch {
		return; // tmpdir unreadable — ignore
	}
	for (const entry of entries) {
		if (!entry.startsWith(tmpPrefix)) continue;
		const entryDir = path.join(tmp, entry);
		const ownerAlive = scratchHomeOwnerAlive(entryDir);
		if (ownerAlive === true) continue; // its writer is still running — never touch a live home
		if (ownerAlive === undefined) {
			let mtimeMs;
			try {
				mtimeMs = fs.statSync(entryDir).mtimeMs;
			} catch {
				continue; // already gone (raced something else) — nothing to do
			}
			if (Date.now() - mtimeMs < SCRATCH_HOME_ORPHAN_AGE_MS) continue; // too young to call orphaned yet
		}
		try {
			fs.rmSync(entryDir, { recursive: true, force: true });
		} catch {
			// a genuine removal error (e.g. permissions) — leave it, swept by a later run instead
		}
	}
}

export function withScratchHome(opts = {}) {
	const { realHome = false, tmpPrefix = "lsp-fixture-home-" } = opts;
	if (realHome) {
		return { dir: undefined, pinned: false, restore: () => {} };
	}
	if (process.env.PI_LENS_HOME?.trim()) {
		// Already pinned by the caller (or a parent process) — respect it.
		return { dir: process.env.PI_LENS_HOME, pinned: false, restore: () => {} };
	}
	// Startup sweep BEFORE minting this run's own dir, so it never sweeps
	// itself (#2670 review F2).
	sweepScratchHomeLeftovers(tmpPrefix);
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), tmpPrefix));
	// Recorded so a LATER run's sweep can tell this one is still alive
	// (review round 2 F1) rather than guessing from whether rmSync throws.
	fs.writeFileSync(
		path.join(dir, SCRATCH_HOME_OWNER_FILE),
		String(process.pid),
	);
	process.env.PI_LENS_HOME = dir;
	const dataDirWasUnset = !process.env.PILENS_DATA_DIR?.trim();
	if (dataDirWasUnset) process.env.PILENS_DATA_DIR = dir;
	// #2670 review F3: the redirect otherwise announces itself nowhere — the
	// pin runs BEFORE `getGlobalPiLensLogDir()`'s own `global-dir-probe-redirect`
	// degradation row could ever fire (that row only exists for the DIFFERENT,
	// unpinned probe-redirect path; `PI_LENS_HOME` wins ahead of it and leaves
	// no trace of its own). One line naming the dir is the only way a human
	// reading this run's output can find where its telemetry/tool installs went.
	console.error(
		`[lsp-fixture-workspace] PI_LENS_HOME pinned to ${dir} (#2506 shape) — this run's tool installs and config_resolved/sessionstart telemetry land there, not the real ~/.pi-lens.`,
	);
	return {
		dir,
		pinned: true,
		restore() {
			delete process.env.PI_LENS_HOME;
			if (dataDirWasUnset) delete process.env.PILENS_DATA_DIR;
		},
	};
}
