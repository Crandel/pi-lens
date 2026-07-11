/**
 * Orphaned LSP process reaper (#472), built on the instance registry (#449
 * slice 1).
 *
 * Split into a PURE decision function (`decideOrphanReaping`) and an IMPURE
 * sweep (`sweepOrphans`) so the decision logic is unit-testable with fake
 * pid tables — no real process spawns/kills in tests.
 *
 * Why the registry reaper, not EOF/processId alone (see issue #472): both are
 * best-effort hints a well-behaved server may honor (typescript-language-server
 * does; ast-grep's native exe does not — an upstream LSP-spec violation). The
 * registry reaper works regardless of why a stdin pipe write-end stayed open
 * after the parent died (Windows handle-inheritance capture) — it identifies
 * dead-parent instances directly and kills the full recorded child tree, with
 * a command-line marker fallback for the case where the pid itself was
 * recycled or the mid-tree pid link is broken (e.g. a dead node-wrapper whose
 * native-exe grandchild is still alive under a different, unrecorded pid).
 *
 * #525 root cause: a parent instance was ONLY ever considered dead via
 * `isPidAlive(instance.pid)` — a raw `process.kill(pid, 0)` check. Unlike
 * child pids (which get a command-line/marker identity check via
 * `matchProcess` to guard against a recycled pid), the PARENT pid had no
 * identity verification at all, because `InstanceEntry` never recorded the
 * parent's own command line. Windows recycles pids far more aggressively than
 * POSIX (no zombie/wait-reaping semantics holding a dead pid "reserved"), so
 * over a long enough window (observed: ~13h) a dead parent's pid is very
 * plausibly reassigned to a live, unrelated process — `isPidAlive` then
 * (correctly, per its own conservative contract) reports "alive", and the
 * stale instance is never reaped, no matter how old its heartbeat is.
 * `decideOrphanReaping` now ALSO reaps on heartbeat staleness
 * (`STALE_HEARTBEAT_MS`) as an independent signal alongside pid-liveness —
 * either one being true is sufficient to classify an instance as dead. This
 * does not require matching identity because a heartbeat this stale for a
 * genuinely live pi-lens process would mean `updateHeartbeat` silently
 * stopped firing for the whole threshold window, which is itself pathological.
 */

/**
 * An instance whose heartbeat is older than this is reaped regardless of
 * pid-liveness (see #525 root-cause note above). Deliberately generous: a
 * long-idle-but-alive session still refreshes its heartbeat every turn end
 * (clients/quiet-window.ts `instance_registry_heartbeat` task) and every
 * `updateHeartbeat` call is cheap, so a healthy process should never go this
 * long without a refresh. 6 hours comfortably exceeds any plausible
 * inter-turn idle gap while still catching the observed 13h-stale case well
 * before it doubles in age again.
 */
export const STALE_HEARTBEAT_MS = 6 * 60 * 60 * 1000;

import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { getGlobalPiLensDir } from "./file-utils.js";
import {
	type InstanceEntry,
	isInstanceRegistryEnabled,
	readInstanceRegistry,
} from "./instance-registry.js";
import { logLatency } from "./latency-logger.js";

const isWindows = process.platform === "win32";

export interface ChildToKill {
	pid: number;
	serverId: string;
	command: string;
}

export interface MarkerSearch {
	marker: string;
	serverId: string;
}

export interface OrphanReapDecision {
	/** Registry entries whose owning pid is confirmed dead — to be dropped
	 *  from the registry once their children are reaped. */
	deadInstances: InstanceEntry[];
	/** Live-pid LSP children belonging to a dead-parent instance — kill these. */
	childrenToKill: ChildToKill[];
	/** Children whose pid is ALSO dead (or already gone) but that carried a
	 *  marker — surfaced so the caller can command-line-search for a live
	 *  process still holding that marker (broken pid chain: e.g. a dead
	 *  node-wrapper whose exec'd native child kept a different, unrecorded pid). */
	markerSearches: MarkerSearch[];
}

/**
 * Whether an instance's PARENT should be treated as dead: either pid-liveness
 * says so, OR its heartbeat is stale beyond `STALE_HEARTBEAT_MS` (#525 —
 * pid-liveness alone is unsound on Windows for a long-dead parent whose pid
 * has since been recycled onto an unrelated live process; see the module
 * docstring). An invalid/unparseable `heartbeatAt` is treated as stale
 * (missing data must never mask an otherwise-dead instance).
 */
function isInstanceParentDead(
	instance: InstanceEntry,
	isPidAlive: (pid: number) => boolean,
	now: number,
): boolean {
	if (!isPidAlive(instance.pid)) return true;
	const heartbeatMs = Date.parse(instance.heartbeatAt);
	if (Number.isNaN(heartbeatMs)) return true;
	return now - heartbeatMs > STALE_HEARTBEAT_MS;
}

/**
 * Markers claimed by any LIVE instance's children. A marker search kills by
 * command-line match, so a marker that a live session also uses must never
 * be searched — killing it would take down the live session's server.
 * Markers are per-process-unique by construction (sgconfig.ts embeds the
 * pid), so this is defense in depth against non-unique markers ever
 * reappearing (#472: the original shared baseline.sgconfig.yml would have
 * made the fallback kill every live ast-grep on the machine).
 */
function collectLiveMarkers(
	registry: InstanceEntry[],
	isPidAlive: (pid: number) => boolean,
	now: number,
): Set<string> {
	const liveMarkers = new Set<string>();
	for (const instance of registry) {
		if (isInstanceParentDead(instance, isPidAlive, now)) continue;
		for (const child of instance.lspChildren) {
			if (child.marker) liveMarkers.add(child.marker);
		}
	}
	return liveMarkers;
}

/**
 * Classify one dead-parent instance's children into kills / marker-searches,
 * appending onto the shared `out` accumulator. Extracted from
 * `decideOrphanReaping` to keep cognitive complexity in check — no behavior
 * change, just the per-instance inner loop pulled out.
 */
function classifyDeadInstanceChildren(
	instance: InstanceEntry,
	isPidAlive: (pid: number) => boolean,
	matchProcess:
		| ((pid: number, expected: { command: string; marker?: string }) => boolean)
		| undefined,
	liveMarkers: Set<string>,
	out: { childrenToKill: ChildToKill[]; markerSearches: MarkerSearch[] },
): void {
	for (const child of instance.lspChildren) {
		const childAlive = isPidAlive(child.pid);
		if (childAlive) {
			const identityOk = matchProcess
				? matchProcess(child.pid, {
						command: child.command,
						marker: child.marker,
					})
				: true;
			if (identityOk) {
				out.childrenToKill.push({
					pid: child.pid,
					serverId: child.serverId,
					command: child.command,
				});
				continue;
			}
		}
		// Child pid is dead, or alive-but-identity-mismatched (recycled pid) —
		// if we have a marker, surface it so the caller can find a live
		// process (e.g. the native exe grandchild) by command-line match.
		// Never surface a marker a live instance also claims (see above).
		if (child.marker && !liveMarkers.has(child.marker)) {
			out.markerSearches.push({ marker: child.marker, serverId: child.serverId });
		}
	}
}

/**
 * Pure decision function: given the registry state and injectable liveness /
 * identity predicates, decide what to kill. Performs zero I/O.
 *
 * @param isPidAlive - `process.kill(pid, 0)`-style liveness check. Must be
 *   CONSERVATIVE: only pid-confirmed-dead (ESRCH) counts as dead. Any
 *   ambiguous result (EPERM, or the caller's fake table saying "unknown")
 *   must be treated as alive — never kill on an ambiguous signal-check.
 * @param matchProcess - optional identity verification (e.g. confirm the
 *   live pid's command line still matches what we recorded) to guard against
 *   a recycled pid coincidentally matching. If omitted, liveness alone is used.
 * @param now - epoch ms "now", for heartbeat-staleness comparison (#525).
 *   Injectable for deterministic tests; defaults to `Date.now()`. A parent
 *   instance is classified dead when EITHER `isPidAlive` says so OR its
 *   `heartbeatAt` is older than `STALE_HEARTBEAT_MS` — pid-liveness alone is
 *   unsound once a long-dead parent's pid has been recycled onto an unrelated
 *   live process (observed on Windows: a ~13h-stale entry survived because
 *   its dead pid coincidentally matched a live, unrelated process).
 */
export function decideOrphanReaping(
	registry: InstanceEntry[],
	isPidAlive: (pid: number) => boolean,
	matchProcess?: (
		pid: number,
		expected: { command: string; marker?: string },
	) => boolean,
	now: number = Date.now(),
): OrphanReapDecision {
	const deadInstances: InstanceEntry[] = [];
	const childrenToKill: ChildToKill[] = [];
	const markerSearches: MarkerSearch[] = [];

	const liveMarkers = collectLiveMarkers(registry, isPidAlive, now);

	for (const instance of registry) {
		if (!isInstanceParentDead(instance, isPidAlive, now)) {
			continue; // parent still alive and heartbeat is fresh — leave it alone
		}
		deadInstances.push(instance);
		classifyDeadInstanceChildren(instance, isPidAlive, matchProcess, liveMarkers, {
			childrenToKill,
			markerSearches,
		});
	}

	return { deadInstances, childrenToKill, markerSearches };
}

// --- Impure liveness / identity / kill helpers ---

/** `process.kill(pid, 0)` liveness check: ESRCH ⇒ dead, anything else
 *  (EPERM, or no error thrown at all) ⇒ conservatively alive. */
function realIsPidAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true; // no throw — process exists and we can signal it
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === "ESRCH") return false; // definitively dead
		// EPERM (exists, no permission) or any other/unknown errno: ambiguous —
		// never treat as dead.
		return true;
	}
}

function windowsExe(name: string): string {
	return path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, "System32", name);
}

/** Resolve an absolute path to `ps` (S4036: never spawn via bare PATH lookup).
 *  Prefers `/bin/ps` (present on virtually every POSIX system), falls back to
 *  `/usr/bin/ps`, and defaults back to `/bin/ps` if neither probe succeeds
 *  (spawn will then fail closed rather than silently resolving via PATH). */
function posixPsPath(): string {
	if (fs.existsSync("/bin/ps")) return "/bin/ps";
	if (fs.existsSync("/usr/bin/ps")) return "/usr/bin/ps";
	return "/bin/ps";
}

/** Escape a value for embedding in a WQL LIKE clause: WQL uses `'` as the
 *  string delimiter (doubled to escape) and `%`/`_` as wildcards — the marker
 *  is an opaque path string, so escape all three before interpolating. */
function escapeWqlLikeValue(value: string): string {
	return value.replaceAll("'", "''").replaceAll(/[%_]/g, (ch) => `[${ch}]`);
}

/** Search running processes whose command line contains `marker` (Windows,
 *  via CIM/WQL). Returns matching pids. Best-effort: any failure ⇒ []. */
async function findPidsByMarkerWindows(marker: string): Promise<number[]> {
	if (!isWindows || !marker) return [];
	const escaped = escapeWqlLikeValue(marker);
	// $PID exclusion: the query's own powershell.exe command line embeds the
	// marker string, so it would match itself.
	const psScript =
		`Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%${escaped}%'" ` +
		`| Where-Object { $_.ProcessId -ne $PID } ` +
		`| Select-Object -ExpandProperty ProcessId`;
	return new Promise((resolve) => {
		try {
			const powershell = windowsExe(
				"WindowsPowerShell\\v1.0\\powershell.exe",
			);
			const child = nodeSpawn(
				powershell,
				["-NoProfile", "-NonInteractive", "-Command", psScript],
				{ shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
			);
			let out = "";
			child.stdout?.on("data", (chunk) => {
				out += chunk.toString();
			});
			child.once("error", () => resolve([]));
			child.once("close", () => {
				const pids = out
					.split(/\r?\n/)
					.map((line) => Number(line.trim()))
					.filter((n) => Number.isFinite(n) && n > 0);
				resolve(pids);
			});
		} catch {
			resolve([]);
		}
	});
}

/** Fetch command lines for a set of pids in one query (Windows: CIM; POSIX:
 *  `ps`). Returns a pid → command-line map; pids that can't be resolved are
 *  simply absent (the caller treats absent as "identity unverifiable — do not
 *  kill by pid"). Best-effort: any failure ⇒ empty map. */
async function queryCommandLines(pids: number[]): Promise<Map<number, string>> {
	const valid = [...new Set(pids.filter((p) => Number.isFinite(p) && p > 0))];
	const map = new Map<number, string>();
	if (valid.length === 0) return map;
	if (isWindows) {
		const filter = valid.map((p) => `ProcessId=${p}`).join(" OR ");
		const psScript =
			`Get-CimInstance Win32_Process -Filter "${filter}" ` +
			`| ForEach-Object { "$($_.ProcessId)\t$($_.CommandLine)" }`;
		return new Promise((resolve) => {
			try {
				const powershell = windowsExe(
					"WindowsPowerShell\\v1.0\\powershell.exe",
				);
				const child = nodeSpawn(
					powershell,
					["-NoProfile", "-NonInteractive", "-Command", psScript],
					{ shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
				);
				let out = "";
				child.stdout?.on("data", (chunk) => {
					out += chunk.toString();
				});
				child.once("error", () => resolve(map));
				child.once("close", () => {
					for (const line of out.split(/\r?\n/)) {
						const tab = line.indexOf("\t");
						if (tab <= 0) continue;
						const pid = Number(line.slice(0, tab).trim());
						if (Number.isFinite(pid) && pid > 0) map.set(pid, line.slice(tab + 1));
					}
					resolve(map);
				});
			} catch {
				resolve(map);
			}
		});
	}
	return new Promise((resolve) => {
		try {
			const child = nodeSpawn(
				posixPsPath(),
				["-p", valid.join(","), "-o", "pid=,args="],
				{ shell: false, stdio: ["ignore", "pipe", "ignore"] },
			);
			let out = "";
			child.stdout?.on("data", (chunk) => {
				out += chunk.toString();
			});
			child.once("error", () => resolve(map));
			child.once("close", () => {
				for (const line of out.split(/\r?\n/)) {
					// Linear parse (S8786/S6594: avoid regex backtracking on
					// attacker-lengthenable ps output) — trim leading whitespace,
					// then split on the first whitespace run: "  1234 args here".
					const trimmed = line.trimStart();
					if (!trimmed) continue;
					let i = 0;
					while (i < trimmed.length && trimmed[i] >= "0" && trimmed[i] <= "9") i++;
					if (i === 0) continue;
					const pidStr = trimmed.slice(0, i);
					let j = i;
					while (j < trimmed.length && (trimmed[j] === " " || trimmed[j] === "\t")) j++;
					const pid = Number(pidStr);
					if (Number.isFinite(pid) && pid > 0) map.set(pid, trimmed.slice(j));
				}
				resolve(map);
			});
		} catch {
			resolve(map);
		}
	});
}

/**
 * Build a `matchProcess` identity predicate from a pid → command-line map
 * (as produced by `queryCommandLines`). PURE — exported for unit testing.
 *
 * Semantics (guarding pid kills against pid recycling):
 * - pid absent from the map ⇒ false: identity is UNVERIFIABLE, so never kill
 *   by pid (the marker-search fallback may still catch a real orphan).
 * - marker recorded and present in the command line ⇒ match (strongest
 *   signal — markers are per-spawn-unique).
 * - else: the recorded command's basename appears (case-insensitive) in the
 *   command line ⇒ match. Empty basename never matches (guard against a
 *   recorded empty/odd command matching everything via `includes("")`).
 */
export function buildIdentityMatcher(
	cmdlines: Map<number, string>,
): (pid: number, expected: { command: string; marker?: string }) => boolean {
	return (pid, expected) => {
		const cmdline = cmdlines.get(pid);
		if (cmdline === undefined) return false; // unverifiable ⇒ never kill by pid
		if (expected.marker && cmdline.includes(expected.marker)) return true;
		const basename = path.basename(expected.command ?? "").toLowerCase();
		if (!basename) return false;
		return cmdline.toLowerCase().includes(basename);
	};
}

/** Force-kill a pid's full process tree. Windows: `taskkill /F /T`. POSIX:
 *  mirror killProcessTree's process-group kill, falling back to a direct
 *  signal. Best-effort: swallow all errors. */
async function killPidTree(pid: number): Promise<void> {
	if (!Number.isFinite(pid) || pid <= 0) return;
	if (isWindows) {
		try {
			const taskkill = windowsExe("taskkill.exe");
			const killer = nodeSpawn(taskkill, ["/F", "/T", "/PID", String(pid)], {
				shell: false,
				windowsHide: true,
				stdio: "ignore",
			});
			await new Promise<void>((resolve) => {
				killer.once("close", () => resolve());
				killer.once("error", () => resolve());
			});
		} catch {
			// best-effort
		}
		return;
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// best-effort — process may already be gone
		}
	}
}

/**
 * Fire-and-forget orphan sweep: reads the registry, decides what's dead via
 * `decideOrphanReaping`, kills orphaned LSP children (by pid, with a
 * marker-based command-line search fallback), then drops fully-dead
 * instances from the registry. Never throws — every step is wrapped so a
 * reap failure cannot block or crash the caller (session_start).
 */
export async function sweepOrphans(): Promise<void> {
	if (!isInstanceRegistryEnabled()) return;
	const startedAt = Date.now();
	try {
		const registry = await readInstanceRegistry();
		if (registry.length === 0) return;

		// Identity verification before any pid kill (recycled-pid guard): fetch
		// the command lines of every recorded child pid in ONE batched query,
		// then let the pure decision function verify each live child's identity
		// against what was recorded at spawn. A pid whose command line can't be
		// fetched is treated as unverifiable and never killed by pid — the
		// marker-search fallback may still catch it.
		const candidatePids = registry.flatMap((instance) =>
			instance.lspChildren.map((child) => child.pid),
		);
		const cmdlines = await queryCommandLines(candidatePids);
		const matchProcess = buildIdentityMatcher(cmdlines);

		const decision = decideOrphanReaping(registry, realIsPidAlive, matchProcess);

		let killedCount = 0;
		const killedServerIds: string[] = [];

		for (const child of decision.childrenToKill) {
			await killPidTree(child.pid);
			killedCount++;
			killedServerIds.push(child.serverId);
		}

		for (const search of decision.markerSearches) {
			try {
				const pids = await findPidsByMarkerWindows(search.marker);
				for (const pid of pids) {
					await killPidTree(pid);
					killedCount++;
					killedServerIds.push(search.serverId);
				}
			} catch {
				// best-effort — a failed marker search just misses that orphan this sweep
			}
		}

		if (decision.deadInstances.length > 0) {
			try {
				const deadPids = new Set(decision.deadInstances.map((i) => i.pid));
				await pruneDeadInstances(deadPids);
			} catch {
				// best-effort — a stale registry entry is re-evaluated next sweep
			}
		}

		try {
			logLatency({
				type: "phase",
				phase: "orphan_lsp_reaped",
				filePath: "",
				durationMs: Date.now() - startedAt,
				metadata: {
					deadInstances: decision.deadInstances.length,
					killed: killedCount,
					serverIds: killedServerIds,
					markerSearches: decision.markerSearches.length,
				},
			});
		} catch {
			// best-effort logging only
		}
	} catch {
		// The sweep must never throw out of session_start.
	}
}

/** Drop dead-parent instances from the registry. Re-reads immediately before
 *  writing (rather than reusing the earlier `readInstanceRegistry()` snapshot)
 *  to narrow — not eliminate — the last-writer-wins race already accepted for
 *  slice 1's read-modify-write model. */
async function pruneDeadInstances(deadPids: Set<number>): Promise<void> {
	const target = path.join(getGlobalPiLensDir(), "instances.json");
	try {
		const raw = await fs.promises.readFile(target, "utf-8");
		const parsed = JSON.parse(raw);
		if (!parsed || !Array.isArray(parsed.instances)) return;
		const remaining = parsed.instances.filter(
			(entry: InstanceEntry) => !deadPids.has(entry.pid),
		);
		if (remaining.length === parsed.instances.length) return;
		const tmpPath = `${target}.tmp-${process.pid}`;
		await fs.promises.mkdir(getGlobalPiLensDir(), { recursive: true });
		await fs.promises.writeFile(
			tmpPath,
			JSON.stringify({ instances: remaining }),
			"utf-8",
		);
		await fs.promises.rename(tmpPath, target);
	} catch {
		// best-effort
	}
}
