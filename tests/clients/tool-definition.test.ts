import { afterEach, describe, expect, it } from "vitest";
import { normalizeToolDefinition } from "../../clients/tool-definition.js";
import {
	_eventLoopHoldCountForTests,
	_eventLoopKeepAliveForTests,
	_resetEventLoopHoldForTests,
} from "../../clients/event-loop-hold.js";

describe("normalizeToolDefinition", () => {
	it.each([
		["missing", undefined],
		["empty", ""],
		["whitespace", " \t\n"],
	])("supplies a description when metadata is %s", (_label, description) => {
		expect(
			normalizeToolDefinition({ name: "child_tool", description }),
		).toMatchObject({
			name: "child_tool",
			description: "Use the child_tool tool.",
		});
	});

	it("preserves a non-empty description and unrelated metadata", () => {
		const tool = {
			name: "wrapped_tool",
			description: " Wrapped path ",
			extra: true,
		};
		expect(normalizeToolDefinition(tool)).toEqual(tool);
	});

	it("falls back to a generic description when name metadata is unavailable", () => {
		expect(normalizeToolDefinition({})).toMatchObject({
			description: "Use the tool tool.",
		});
	});
});

/**
 * #2507: the registration boundary is also where an in-flight tool call takes
 * its event-loop hold, because it is the ONE place every registered pi-lens
 * tool passes through (`index.ts`'s `pi.registerTool` loop). A tool call that
 * did not hold the loop let a headless child exit 0 mid `lsp_diagnostics`.
 */
describe("normalizeToolDefinition — event-loop hold", () => {
	afterEach(() => {
		_resetEventLoopHoldForTests();
	});

	it("holds a referenced handle for the lifetime of a tool call", async () => {
		let settle: (() => void) | undefined;
		const tool = normalizeToolDefinition({
			name: "slow_tool",
			description: "Slow",
			execute: async () => {
				await new Promise<void>((resolve) => {
					settle = resolve;
				});
				return "done";
			},
		});

		const pending = (tool.execute as () => Promise<unknown>)();
		// Synchronously after the call: the hold is taken BEFORE the inner
		// execute runs, so nothing awaited inside it can drain the loop.
		expect(_eventLoopHoldCountForTests()).toBe(1);
		expect(_eventLoopKeepAliveForTests()).toEqual({
			armed: true,
			hasRef: true,
		});

		settle?.();
		await expect(pending).resolves.toBe("done");
		expect(_eventLoopHoldCountForTests()).toBe(0);
		expect(_eventLoopKeepAliveForTests().armed).toBe(false);
	});

	it("releases the hold when the tool call rejects", async () => {
		const tool = normalizeToolDefinition({
			name: "failing_tool",
			description: "Fails",
			execute: async () => {
				throw new Error("boom");
			},
		});

		await expect((tool.execute as () => Promise<unknown>)()).rejects.toThrow(
			"boom",
		);
		expect(_eventLoopHoldCountForTests()).toBe(0);
		expect(_eventLoopKeepAliveForTests().armed).toBe(false);
	});

	it("passes the call's arguments and `this` through untouched", async () => {
		const seen: unknown[] = [];
		const base = {
			name: "arg_tool",
			description: "Args",
			marker: "self",
			async execute(this: { marker?: string }, ...args: unknown[]) {
				seen.push(...args, this?.marker);
				return "ok";
			},
		};
		const tool = normalizeToolDefinition(base);
		await expect(
			(tool.execute as (...args: unknown[]) => Promise<unknown>).call(
				tool,
				"call-1",
				{ paths: ["a.py"] },
			),
		).resolves.toBe("ok");
		expect(seen).toEqual(["call-1", { paths: ["a.py"] }, "self"]);
	});

	it("leaves a definition with no execute alone", () => {
		const tool = normalizeToolDefinition({ name: "meta_only" });
		expect(tool).not.toHaveProperty("execute");
	});
});
