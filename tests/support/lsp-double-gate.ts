/**
 * Structural detector for hand-rolled `LSPService` doubles — #2582 round 2.
 *
 * The first cut of this gate was the literal string `touchFile: vi.fn(`. A
 * review broke it five ways in one sitting, and every break is a real shape
 * that lives in `tests/` today:
 *
 *   (a) SHORTHAND — `const touchFile = vi.fn(); ... { supportsLSP, touchFile,
 *       openFile }` (live at `tests/tools/lsp-diagnostics-per-server-
 *       concurrency.test.ts` and `tests/clients/runtime-session-warm.test.ts`);
 *   (b) a NON-`vi.fn` stub — `touchFile: async () => ({ diags: [] })`;
 *   (c) POST-HOC patching — `const service = {}; service.touchFile = vi.fn()`,
 *       where the literal itself carries nothing to match;
 *   (d) MULTILINE — `touchFile: vi` + newline + `.fn()`, which a
 *       whitespace-free regex cannot see at all;
 *
 * and one attack on the sweep rather than on the code:
 *
 *   (e) IDENTIFIER LAUNDERING — `const makeTouchFileMock = vi.fn;` plus
 *       `touchFile: makeTouchFileMock()`, which renames the literal out of the
 *       regex's reach while changing nothing at runtime. `sweep-kit.ts` names
 *       this attack family; round 1 of this sweep shipped 28 of them in
 *       `cascade-compute.test.ts` purely to stay green.
 *
 * So this is an AST analysis, not a text scan, and it asks a SEMANTIC
 * question (#2549): what object does this file hand to a `getLSPService`
 * stub, and was that object SEEDED from `makeLspServiceDouble`? None of
 * (a)-(e) changes the answer, because none of them changes the shape or the
 * seam.
 *
 * ## Anchored on the seam, not on the vocabulary
 *
 * An earlier cut flagged any object literal carrying two `LSPService` method
 * names. It found 159 objects in 65 files — but most were fake LSP *clients*
 * in `tests/clients/lsp/*`, built by `createLSPClient` mocks, which share
 * `getDiagnostics`/`openFile`/`documentSymbol` with the service and are a
 * DIFFERENT seam with its own factory story. Matching a name vocabulary alone
 * cannot tell those apart. So the walk starts at the `getLSPService` stub —
 * `vi.mocked(getLSPService).mockReturnValue(x)`, `mocks.getLSPService
 * .mockReturnValue(x)`, `getLSPService: () => x`, `getLSPService: vi.fn(() =>
 * x)` — and resolves `x` back to the object literal it names, through
 * `as`-casts, local `const`s, local factory functions, `vi.fn()` wrappers and
 * one hop of `holder.current` indirection.
 *
 * ## The vocabulary is derived, never hand-maintained
 *
 * {@link lspServiceMethodNames} is `Object.keys(makeLspServiceDouble())` — the
 * factory's own default surface. A method added to the factory widens the
 * detector in the same commit; a hand-copied roster beside the factory would
 * be exactly the mirrored-registry defect AGENTS.md forbids. The vocabulary is
 * a filter on the resolved object, not the anchor.
 *
 * ## What it deliberately PERMITS
 *
 * A focused override on a factory-seeded object (`makeLspServiceDouble({
 * touchFile: vi.fn() })`, or a spread of one) is the factory's documented
 * usage and is NOT a violation. A detector that forbade it would push authors
 * straight back to hand-rolling — which is how round 1 ended up laundering
 * identifiers to keep its own sweep green.
 *
 * ## What it cannot see
 *
 * A double assembled by a helper in ANOTHER module, one reached through more
 * indirection than {@link MAX_RESOLUTION_DEPTH} hops, and one installed
 * through a computed key. Each is a false NEGATIVE — the safe direction for a
 * ratchet whose job is to stop a known population from growing.
 */

import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAstGrepNapi } from "../../clients/deps/ast-grep-napi.js";
import type { SgNode } from "../../clients/deps/ast-grep-napi.js";
import { makeLspServiceDouble } from "./lsp-service-double.js";

export const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

/** The factory's own default surface — the single source of truth (#2582). */
export function lspServiceMethodNames(): ReadonlySet<string> {
	return new Set(Object.keys(makeLspServiceDouble()));
}

/** Indirection hops the resolver will follow before giving up. */
export const MAX_RESOLUTION_DEPTH = 8;

const FACTORY = "makeLspServiceDouble";
const FACTORY_CALL = /\bmakeLspServiceDouble\s*\(/;
const SEAM = "getLSPService";
const MOCK_INSTALLERS = new Set([
	"mockReturnValue",
	"mockReturnValueOnce",
	"mockImplementation",
	"mockImplementationOnce",
	"mockResolvedValue",
]);

export interface HandRolledDouble {
	/** 1-based line of the offending object literal or post-hoc assignment. */
	line: number;
	/** `"object"` for a literal wearing the shape, `"assign"` for post-hoc patching. */
	shape: "object" | "assign";
	/** The `LSPService` method names that made it match, sorted. */
	keys: string[];
}

function unquote(text: string): string {
	return text.replace(/^["'`]|["'`]$/g, "");
}

/** Property names carried by one object literal node, shorthand and methods included. */
function objectKeys(node: SgNode): string[] {
	const keys: string[] = [];
	for (const child of node.children()) {
		const kind = child.kind();
		if (kind === "pair") {
			const key = child.field("key");
			if (key) keys.push(unquote(key.text()));
		} else if (kind === "shorthand_property_identifier") {
			keys.push(child.text());
		} else if (kind === "method_definition") {
			const name = child.field("name");
			if (name) keys.push(unquote(name.text()));
		}
	}
	return keys;
}

/** True when this object literal spreads a `makeLspServiceDouble(...)` result. */
function spreadsFactory(node: SgNode): boolean {
	return node
		.children()
		.some(
			(child) =>
				child.kind() === "spread_element" && FACTORY_CALL.test(child.text()),
		);
}

/**
 * One module's resolution scope: every `const`/`let`/`function` binding, so an
 * expression handed to the seam can be traced back to the literal it names.
 */
class Scope {
	readonly declarators = new Map<string, SgNode>();
	readonly functions = new Map<string, SgNode>();
	/** `holder.current = x` style writes, keyed by the whole `holder.current` text. */
	readonly memberWrites = new Map<string, SgNode[]>();

	constructor(root: SgNode) {
		for (const declarator of root.findAll({
			rule: { kind: "variable_declarator" },
		})) {
			const name = declarator.field("name");
			const value = declarator.field("value");
			if (name && value && name.kind() === "identifier") {
				this.declarators.set(name.text(), value);
			}
		}
		for (const fn of root.findAll({ rule: { kind: "function_declaration" } })) {
			const name = fn.field("name");
			if (name) this.functions.set(name.text(), fn);
		}
		for (const assignment of root.findAll({
			rule: { kind: "assignment_expression" },
		})) {
			const left = assignment.field("left");
			const right = assignment.field("right");
			if (!left || !right || left.kind() !== "member_expression") continue;
			const key = left.text();
			const existing = this.memberWrites.get(key) ?? [];
			existing.push(right);
			this.memberWrites.set(key, existing);
		}
	}
}

/** `return` expressions of a function-ish node, plus a concise arrow's body. */
function returnedExpressions(fn: SgNode): SgNode[] {
	const body = fn.field("body");
	if (!body) return [];
	if (body.kind() !== "statement_block") return [body];
	return fn
		.findAll({ rule: { kind: "return_statement" } })
		.map((statement) => statement.children().find((c) => c.isNamed()))
		.filter((node): node is SgNode => node !== undefined);
}

/**
 * Resolve an expression handed to the `getLSPService` seam back to the object
 * literals it can name. `seeded` collects the calls that went through the
 * factory instead, so a caller can tell "compliant" from "nothing found".
 */
function resolveObjects(
	node: SgNode,
	scope: Scope,
	seen: Set<string>,
	depth = 0,
): SgNode[] {
	if (depth > MAX_RESOLUTION_DEPTH) return [];
	const key = `${node.kind()}@${node.range().start.index}`;
	if (seen.has(key)) return [];
	seen.add(key);
	const recurse = (next: SgNode) =>
		resolveObjects(next, scope, seen, depth + 1);

	switch (node.kind()) {
		case "object":
			return [node];
		case "parenthesized_expression":
		case "as_expression":
		case "satisfies_expression":
		case "non_null_expression": {
			const inner = node.children().find((c) => c.isNamed());
			return inner ? recurse(inner) : [];
		}
		case "identifier": {
			const bound = scope.declarators.get(node.text());
			if (bound) return recurse(bound);
			const fn = scope.functions.get(node.text());
			return fn ? returnedExpressions(fn).flatMap(recurse) : [];
		}
		case "member_expression": {
			// `mocked.service` / `serviceHolder.current`: follow the writes AND a
			// matching property on the holder's own literal.
			const writes = scope.memberWrites.get(node.text()) ?? [];
			const holder = node.field("object");
			const property = node.field("property");
			const viaLiteral: SgNode[] = [];
			if (holder?.kind() === "identifier" && property) {
				for (const literal of recurse(holder)) {
					for (const child of literal.children()) {
						if (child.kind() !== "pair") continue;
						const pairKey = child.field("key");
						const pairValue = child.field("value");
						if (
							pairKey &&
							pairValue &&
							unquote(pairKey.text()) === property.text()
						) {
							viaLiteral.push(...recurse(pairValue));
						}
					}
				}
			}
			return [...writes.flatMap(recurse), ...viaLiteral];
		}
		case "arrow_function":
		case "function_expression":
			return returnedExpressions(node).flatMap(recurse);
		case "call_expression": {
			const callee = node.field("function");
			// A factory call is COMPLIANT: stop here and report nothing.
			if (callee?.text() === FACTORY) return [];
			const args =
				node
					.field("arguments")
					?.children()
					.filter((c) => c.isNamed()) ?? [];
			// `vi.fn(() => service)` and friends: the double is the argument.
			if (callee?.text().endsWith("vi.fn") || callee?.text() === "fn") {
				return args.flatMap(recurse);
			}
			// A local factory function: follow its returns.
			if (callee?.kind() === "identifier") return recurse(callee);
			return [];
		}
		default:
			return [];
	}
}

/**
 * The identifier an expression names, through `as`-casts, parentheses and
 * non-null assertions. `mockReturnValue(service as never)` hands the seam an
 * `as_expression`, not an identifier — reading the kind directly is why the
 * post-hoc shape (c) went undetected until a mutation probe found the branch
 * was unreachable.
 */
function bareIdentifier(node: SgNode): string | undefined {
	let current: SgNode | undefined = node;
	for (let hop = 0; current && hop <= MAX_RESOLUTION_DEPTH; hop++) {
		if (current.kind() === "identifier") return current.text();
		if (
			current.kind() !== "as_expression" &&
			current.kind() !== "parenthesized_expression" &&
			current.kind() !== "non_null_expression" &&
			current.kind() !== "satisfies_expression"
		) {
			return undefined;
		}
		current = current.children().find((c) => c.isNamed());
	}
	return undefined;
}

/** Expressions this module hands to a `getLSPService` stub. */
function seamExpressions(root: SgNode): SgNode[] {
	const expressions: SgNode[] = [];

	// `<anything mentioning getLSPService>.mockReturnValue(x)` and friends.
	for (const call of root.findAll({ rule: { kind: "call_expression" } })) {
		const callee = call.field("function");
		if (!callee || callee.kind() !== "member_expression") continue;
		const method = callee.field("property")?.text() ?? "";
		if (!MOCK_INSTALLERS.has(method)) continue;
		if (!(callee.field("object")?.text() ?? "").includes(SEAM)) continue;
		for (const argument of call.field("arguments")?.children() ?? []) {
			if (argument.isNamed()) expressions.push(argument);
		}
	}

	// `getLSPService: <expression>` inside a `vi.mock` factory or a fake module.
	for (const pair of root.findAll({ rule: { kind: "pair" } })) {
		const key = pair.field("key");
		const value = pair.field("value");
		if (!key || !value || unquote(key.text()) !== SEAM) continue;
		expressions.push(value);
	}

	return expressions;
}

/**
 * Every hand-rolled `LSPService` double in one TypeScript source, as
 * `{ line, shape, keys }`. Factory-seeded objects and focused overrides on
 * them are not violations; see the module doc.
 */
export async function findHandRolledLspDoubles(
	source: string,
): Promise<HandRolledDouble[]> {
	const napi = await loadAstGrepNapi();
	const root = napi.parse(napi.Lang.TypeScript, source).root();
	const vocabulary = lspServiceMethodNames();
	const scope = new Scope(root);

	const doubles = new Map<number, HandRolledDouble>();
	const handRolledBindings = new Set<string>();

	for (const expression of seamExpressions(root)) {
		const bare = bareIdentifier(expression);
		if (bare) handRolledBindings.add(bare);
		for (const object of resolveObjects(expression, scope, new Set())) {
			if (spreadsFactory(object)) continue;
			const keys = [
				...new Set(objectKeys(object).filter((k) => vocabulary.has(k))),
			];
			const line = object.range().start.line + 1;
			doubles.set(line, { line, shape: "object", keys: keys.sort() });
		}
	}

	// Shape (c): a double built empty and patched afterwards. Only bindings the
	// seam actually receives are considered, and a factory-seeded one is the
	// documented focused-override usage, not a violation.
	for (const [name, value] of scope.declarators) {
		if (FACTORY_CALL.test(value.text())) continue;
		if (!handRolledBindings.has(name)) continue;
		for (const [target, writes] of scope.memberWrites) {
			const [holder, property] = target.split(".");
			if (holder !== name || !property || !vocabulary.has(property)) continue;
			for (const write of writes) {
				const line = write.range().start.line + 1;
				if (doubles.has(line)) continue;
				doubles.set(line, { line, shape: "assign", keys: [property] });
			}
		}
	}

	return [...doubles.values()].sort((a, b) => a.line - b.line);
}
