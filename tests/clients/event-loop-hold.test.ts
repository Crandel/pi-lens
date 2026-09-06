/**
 * #2507 — the counted keep-alive's own state machine.
 *
 * The END-TO-END property (a real headless child neither exiting mid-call nor
 * hanging after it) lives in
 * `tests/clients/lsp/headless-tool-call-keepalive.test.ts`, where a real
 * process's real event loop is the thing under observation. What is provable
 * in-process, and what this file pins, is everything that decides WHETHER a
 * referenced handle exists at each moment: arm on the first hold, stay armed
 * across overlapping holds, disarm on the last release, and — the inverse
 * defect — force-release past the bound so a leaked hold cannot pin a process
 * open forever.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	acquireEventLoopHold,
	getEventLoopHoldMaxMs,
	_eventLoopHoldCountForTests,
	_eventLoopKeepAliveForTests,
	_resetEventLoopHoldForTests,
} from "../../clients/event-loop-hold.js";
import { getWorkspaceSweepMaxHoldAgeMs } from "../../clients/lsp/workspace-sweep-hold.js";

const logLatencyMock = vi.fn();

vi.mock("../../clients/latency-logger.js", async (importActual) => ({
	...(await importActual<typeof import("../../clients/latency-logger.js")>()),
	logLatency: (entry: unknown) => logLatencyMock(entry),
}));

function loggedPhase(phase: string): boolean {
	return logLatencyMock.mock.calls.some(
		(call: unknown[]) => (call[0] as { phase?: string })?.phase === phase,
	);
}

describe("event-loop hold (#2507)", () => {
	beforeEach(() => {
		logLatencyMock.mockClear();
		_resetEventLoopHoldForTests();
	});

	afterEach(() => {
		_resetEventLoopHoldForTests();
		vi.useRealTimers();
	});

	it("holds nothing while idle", () => {
		expect(_eventLoopHoldCountForTests()).toBe(0);
		expect(_eventLoopKeepAliveForTests()).toEqual({
			armed: false,
			hasRef: false,
		});
	});

	it("arms a REFERENCED handle for the first hold and disarms on the last release", () => {
		const release = acquireEventLoopHold("lsp_diagnostics");
		// `hasRef` is the whole point: an armed-but-unref'd handle would leave
		// the loop exactly as drainable as it was before the fix.
		expect(_eventLoopKeepAliveForTests()).toEqual({
			armed: true,
			hasRef: true,
		});
		release();
		expect(_eventLoopHoldCountForTests()).toBe(0);
		expect(_eventLoopKeepAliveForTests()).toEqual({
			armed: false,
			hasRef: false,
		});
	});

	it("stays armed while an overlapping hold is still outstanding", () => {
		const first = acquireEventLoopHold("lsp_diagnostics");
		const second = acquireEventLoopHold("lens_diagnostics");
		expect(_eventLoopHoldCountForTests()).toBe(2);
		first();
		expect(_eventLoopHoldCountForTests()).toBe(1);
		expect(_eventLoopKeepAliveForTests().armed).toBe(true);
		second();
		expect(_eventLoopKeepAliveForTests().armed).toBe(false);
	});

	it("releases idempotently — a double release never drops someone else's hold", () => {
		const first = acquireEventLoopHold("lsp_diagnostics");
		const second = acquireEventLoopHold("symbol_search");
		first();
		first();
		expect(_eventLoopHoldCountForTests()).toBe(1);
		expect(_eventLoopKeepAliveForTests().armed).toBe(true);
		second();
		expect(_eventLoopHoldCountForTests()).toBe(0);
	});

	it("force-releases past the bound so a leaked hold cannot pin the process open", () => {
		vi.useFakeTimers();
		acquireEventLoopHold("lsp_diagnostics");
		expect(_eventLoopKeepAliveForTests().armed).toBe(true);

		vi.advanceTimersByTime(getEventLoopHoldMaxMs() + 1);

		expect(_eventLoopHoldCountForTests()).toBe(0);
		expect(_eventLoopKeepAliveForTests().armed).toBe(false);
		expect(loggedPhase("event_loop_hold_force_released")).toBe(true);
		const record = logLatencyMock.mock.calls
			.map((call) => call[0] as { phase?: string; metadata?: unknown })
			.find((entry) => entry.phase === "event_loop_hold_force_released");
		expect(record?.metadata).toMatchObject({
			releasedHolds: 1,
			labels: ["lsp_diagnostics"],
		});
	});

	it("derives its bound from the longest legitimate operation's own ceiling", () => {
		// Not a second tunable literal: the full-scan wall clock plus the shared
		// safety margin, the same derivation the workspace-sweep hold's max-age
		// failsafe uses (AGENTS.md shape 15's "derive, don't re-declare").
		expect(getEventLoopHoldMaxMs()).toBe(getWorkspaceSweepMaxHoldAgeMs());
	});
});
