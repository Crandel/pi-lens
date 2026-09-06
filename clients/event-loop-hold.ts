/**
 * #2507: hold the event loop for the lifetime of in-flight work that would
 * otherwise be kept alive by NOTHING.
 *
 * Every handle pi-lens owns on the way to an LSP answer is deliberately
 * unref'd. `clients/lsp/launch.ts#unrefLspProcessHandles` unrefs the language
 * server child AND its three stdio pipes so a settled one-shot `pi --print`
 * can exit without waiting for a lingering server (the #1097/#1110 class);
 * `clients/child-unref.ts` does the same for every fire-and-forget probe
 * spawn; `bounded()` and several LSP waits unref their timers for the same
 * reason. That is correct for an IDLE process and wrong for a BUSY one: in a
 * headless child (`pi --mode json -p --no-extensions`, stdin ignored, no TUI,
 * no other extension holding a socket or timer) an in-flight `lsp_diagnostics`
 * call reaches a point where the only thing it is waiting on is an unref'd
 * timer or an unref'd pipe, libuv finds no referenced handle, and Node exits 0
 * IN THE MIDDLE of the tool call — no error, no result, no `turn_end`. The
 * reporter measured it against pyright; the drain site the repro lands on is
 * `LSPService.ensureWarmForSweep`'s warm-up retry backoff (an explicitly
 * `.unref()`'d `setTimeout`), but it is one of many: any await whose only
 * pending handle is unref'd has the same shape.
 *
 * The fix is NOT to stop unref'ing — that would leak a lingering server into
 * every settled one-shot process, which is the reason the unref exists. It is
 * to hold ONE referenced handle for exactly as long as something is in
 * flight: a counted keep-alive, armed while at least one hold is taken and
 * disarmed the moment the last one is released. Idle behaviour is therefore
 * byte-identical to before — no hold, no timer, nothing referenced.
 *
 * Shape 15's screen (AGENTS.md), which this follows deliberately:
 *  - a COUNTER of tokens, not a boolean, so overlapping tool calls each
 *    release independently and a throwing/aborted caller still releases
 *    (callers release from `finally`);
 *  - a bounded lifetime, because a leaked hold is the INVERSE defect (a
 *    process that can never exit). The armed timer is not infinite: it is a
 *    single `setTimeout` of {@link getEventLoopHoldMaxMs}, derived from the
 *    longest legitimate operation's OWN ceiling
 *    (`getWorkspaceSweepMaxHoldAgeMs`, i.e. the full-scan wall clock plus its
 *    safety margin) rather than a second, independently-drifting literal.
 *    When it fires with holds still outstanding, every hold is force-released
 *    with its own log record and the loop is free again — the pre-#2507
 *    behaviour, but recorded instead of silent.
 *
 * There is deliberately NO session-boundary clear here, unlike
 * `clients/lsp/workspace-sweep-hold.ts`. A `session_start` can land mid-turn
 * (see `clients/bootstrap.ts`), so clearing holds on a session boundary would
 * un-hold a tool call that is still running and reintroduce this exact defect
 * for it. The hold is scoped to one call's try/finally, not to a session.
 */

import { logLatency } from "./latency-logger.js";
import { getWorkspaceSweepMaxHoldAgeMs } from "./lsp/workspace-sweep-hold.js";
import { getProcessSingleton } from "./process-singletons.js";

interface EventLoopHoldEntry {
	acquiredAt: number;
	label: string;
}

interface EventLoopHoldState {
	holds: Map<number, EventLoopHoldEntry>;
	nextHoldId: number;
	/** The ONE referenced handle. `undefined` whenever nothing is held. */
	timer: ReturnType<typeof setTimeout> | undefined;
}

const EVENT_LOOP_HOLD_FAMILY = "event-loop-hold";
const EVENT_LOOP_HOLD_VERSION = 1;

/**
 * Process-scoped on purpose: pi evaluates the pi-lens module graph more than
 * once in one process (see `clients/process-singletons.ts`), and what is being
 * counted here is a property of the PROCESS's event loop, not of one module
 * evaluation. Two copies would arm two timers for one loop.
 */
function state(): EventLoopHoldState {
	return getProcessSingleton(
		EVENT_LOOP_HOLD_FAMILY,
		EVENT_LOOP_HOLD_VERSION,
		() => ({ holds: new Map(), nextHoldId: 1, timer: undefined }),
	);
}

/**
 * Upper bound on how long ONE hold may keep this process alive. Derived from
 * `lens_diagnostics mode=full`'s own wall-clock ceiling plus the shared
 * `SWEEP_IDLE_SAFETY_MARGIN_MS` — the same derivation the workspace-sweep
 * hold's max-hold-age failsafe uses, so the two cannot drift apart into a
 * relationship where the longest legitimate tool call outlives the bound that
 * is supposed to only catch bugs.
 */
export function getEventLoopHoldMaxMs(): number {
	return getWorkspaceSweepMaxHoldAgeMs();
}

function armIfHeld(current: EventLoopHoldState): void {
	if (current.timer !== undefined) return;
	if (current.holds.size === 0) return;
	const maxMs = getEventLoopHoldMaxMs();
	// NOT `unref()`'d — referencing the loop is this timer's entire job. It is
	// also the failsafe: when it fires, the hold is over either way.
	current.timer = setTimeout(() => forceReleaseAll(maxMs), maxMs);
}

function disarmIfIdle(current: EventLoopHoldState): void {
	if (current.holds.size > 0) return;
	if (current.timer === undefined) return;
	clearTimeout(current.timer);
	current.timer = undefined;
}

function forceReleaseAll(maxMs: number): void {
	const current = state();
	current.timer = undefined;
	if (current.holds.size === 0) return;
	const held = [...current.holds.values()];
	const oldestAcquiredAt = Math.min(...held.map((entry) => entry.acquiredAt));
	current.holds.clear();
	logLatency({
		type: "phase",
		phase: "event_loop_hold_force_released",
		filePath: "",
		durationMs: Date.now() - oldestAcquiredAt,
		metadata: {
			maxHoldMs: maxMs,
			releasedHolds: held.length,
			labels: [...new Set(held.map((entry) => entry.label))].slice(0, 8),
		},
	});
}

/**
 * Take one hold for the lifetime of a piece of in-flight work, and return its
 * release. Callers MUST release from a `finally` block: a throw, a rejection
 * or an abort has to release exactly like a normal return, or the hold leaks
 * and the process stops being able to exit.
 *
 * The release is identity-guarded and idempotent — calling it twice, or after
 * the max-age failsafe already force-released it, is a no-op and never
 * disarms another caller's hold.
 */
export function acquireEventLoopHold(label: string): () => void {
	const current = state();
	const holdId = current.nextHoldId++;
	current.holds.set(holdId, { acquiredAt: Date.now(), label });
	armIfHeld(current);
	return () => {
		const now = state();
		if (!now.holds.delete(holdId)) return;
		disarmIfIdle(now);
	};
}

/** Test-only: how many holds are outstanding right now. */
export function _eventLoopHoldCountForTests(): number {
	return state().holds.size;
}

/**
 * Test-only: the keep-alive handle's own state. `hasRef` is the property the
 * whole fix rests on — a handle that is armed but unref'd holds nothing — so
 * it is read from the live `Timeout` (`hasRef()`), not asserted from the
 * source text.
 */
export function _eventLoopKeepAliveForTests(): {
	armed: boolean;
	hasRef: boolean;
} {
	const timer = state().timer as
		| (ReturnType<typeof setTimeout> & { hasRef?: () => boolean })
		| undefined;
	return {
		armed: timer !== undefined,
		hasRef: timer?.hasRef?.() === true,
	};
}

/** Test-only: drop every hold and disarm, between tests. */
export function _resetEventLoopHoldForTests(): void {
	const current = state();
	current.holds.clear();
	if (current.timer !== undefined) clearTimeout(current.timer);
	current.timer = undefined;
	current.nextHoldId = 1;
}
