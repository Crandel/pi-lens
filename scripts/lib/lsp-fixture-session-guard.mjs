import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * #2369/#2655. Every LSP dev-harness script (`smoke-tools.mjs`,
 * `characterize-lsp.mjs`, `probe-clean-signal.mjs`, `server-capabilities.mjs`)
 * iterates a shared fixture list in ONE process, giving each fixture a
 * fresh, unregistered `os.tmpdir()` workspace. `clients/lsp/session-roots.ts`
 * fails OPEN (declines nothing) only while its registry is empty — the
 * moment any fixture registers its own workspace as a served session root
 * (via `initLSPConfig`, #2052), the registry goes non-empty and every OTHER
 * fixture's still-unregistered workspace is silently declined by
 * `isOutsideAllSessionRoots`. `smoke-tools.mjs`'s `--lsp` lane shipped this
 * exact bug for 12 nightlies (#2369) because `initLSPConfig` was called only
 * for `disableServers` fixtures; `characterize-lsp.mjs` was independently
 * confirmed live-affected the same way for #2655.
 *
 * The actual fix in each script is one line — call `initLSPConfig(workspace)`
 * unconditionally right after copying the fixture into its temp workspace,
 * not only inside a `disableServers` branch. This module is NOT that line
 * (each script still calls its own already-imported `initLSPConfig`, since
 * that import path differs slightly per script); it is ONLY the guard that
 * makes the ordering dependency impossible to silently reintroduce: assert
 * the workspace is actually registered before anything touches it, and
 * throw loudly, naming the issue, if it is not. One implementation, four
 * call sites — a hand-copied guard in each script is exactly the kind of
 * drift a future edit to one copy and not the others would reintroduce.
 */

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
);

let isSessionRootRegisteredPromise;
function loadIsSessionRootRegistered() {
	if (!isSessionRootRegisteredPromise) {
		const entry = path.join(
			repoRoot,
			"dist",
			"clients",
			"lsp",
			"session-roots.js",
		);
		isSessionRootRegisteredPromise = import(pathToFileURL(entry).href).then(
			(m) => m.isSessionRootRegistered,
		);
	}
	return isSessionRootRegisteredPromise;
}

/**
 * Throws if `workspace` was never registered as a served session root.
 * Call this AFTER the fixture's unconditional `initLSPConfig(workspace)`
 * and any `disableServers` reload, but BEFORE anything touches the file
 * (`supportsLSP`, `touchFile`, etc.) — the whole point is to fail loudly at
 * the exact point the pre-#2369 code silently returned zero diagnostics.
 */
export async function assertFixtureWorkspaceRegistered(lang, workspace) {
	const isSessionRootRegistered = await loadIsSessionRootRegistered();
	if (!isSessionRootRegistered(workspace)) {
		throw new Error(
			`[${lang}] fixture workspace ${workspace} was touched without being registered as a session root (#2369/#2655) — every fixture must call initLSPConfig(workspace) before use`,
		);
	}
}
