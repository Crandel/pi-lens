import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import * as bundledResourceHealth from "../../clients/bundled-resource-health.js";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	BUNDLED_QUERIES_ROOT,
	getQueryLanguageKey,
	isDisabledQueryFilePath,
	queriesForLanguage,
	ruleFilesForLanguage,
	ruleSourceLanguages,
	type TreeSitterQuery,
	TreeSitterQueryLoader,
} from "../../clients/tree-sitter-query-loader.js";
import {
	resetUserNotifier,
	wireUserNotifier,
} from "../../clients/user-notify.js";
import { removeTempDirSync } from "./test-utils.js";

const tmpDirs: string[] = [];

function writeRule(root: string, relPath: string, content: string): void {
	const filePath = path.join(root, relPath);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, "utf-8");
}

function makeTempRulesRoot(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-query-loader-"));
	tmpDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tmpDirs) {
		removeTempDirSync(dir);
	}
});

describe("tree-sitter query loader metadata parsing", () => {
	it("parses cwe/owasp/confidence in inline arrays", async () => {
		const root = makeTempRulesRoot();
		writeRule(
			root,
			"rules/tree-sitter-queries/typescript/meta-inline.yml",
			`id: meta-inline
name: Meta Inline
severity: warning
category: security
language: typescript
message: test
query: |
  (identifier) @X
metavars: [X]
cwe: [CWE-327, CWE-330]
owasp: [A02]
confidence: high
defect_class: injection
inline_tier: warning
has_fix: false
`,
		);

		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);
		const query = loader.getQueryById("meta-inline");
		expect(query).toBeTruthy();
		expect(query?.cwe).toEqual(["CWE-327", "CWE-330"]);
		expect(query?.owasp).toEqual(["A02"]);
		expect(query?.confidence).toBe("high");
	});

	it("parses multiline arrays with comments and quoted confidence", async () => {
		const root = makeTempRulesRoot();
		writeRule(
			root,
			"rules/tree-sitter-queries/python/meta-multiline.yml",
			`id: meta-multiline
name: Meta Multiline
severity: warning
category: security
language: python
message: test
query: |
  (identifier) @X
metavars:
  - X
cwe:
  - CWE-89 # SQLi
  - CWE-22
owasp:
  - A03
  - A01
confidence: "medium"
defect_class: injection
inline_tier: warning
has_fix: false
`,
		);

		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);
		const query = loader.getQueryById("meta-multiline");
		expect(query).toBeTruthy();
		expect(query?.cwe).toEqual(["CWE-89", "CWE-22"]);
		expect(query?.owasp).toEqual(["A03", "A01"]);
		expect(query?.confidence).toBe("medium");
	});

	it("preserves tree-sitter predicates in query blocks", async () => {
		const root = makeTempRulesRoot();
		writeRule(
			root,
			"rules/tree-sitter-queries/typescript/predicate-preserve.yml",
			`id: predicate-preserve
name: Predicate Preserve
severity: warning
category: correctness
language: typescript
message: test
query: |
  (call_expression
    function: (member_expression
      object: (identifier) @OBJ
      property: (property_identifier) @FN))
  (#eq? @OBJ "Math")
  (#eq? @FN "random")
metavars:
  - OBJ
  - FN
defect_class: correctness
inline_tier: warning
has_fix: false
`,
		);

		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);
		const query = loader.getQueryById("predicate-preserve");
		expect(query).toBeTruthy();
		expect(query?.query).toContain('#eq? @OBJ "Math"');
		expect(query?.query).toContain('#eq? @FN "random"');
	});

	it("loads disabled-directory rules for tests but excludes them from production language queries", async () => {
		const root = makeTempRulesRoot();
		writeRule(
			root,
			"rules/tree-sitter-queries/python-disabled/disabled-example.yml",
			`id: disabled-example
name: Disabled Example
severity: warning
category: correctness
language: python
message: test
query: |
  (identifier) @X
metavars:
  - X
defect_class: correctness
inline_tier: warning
has_fix: false
`,
		);

		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);
		expect(loader.getAllQueries().map((q) => q.id)).toContain(
			"disabled-example",
		);
		expect(
			loader.getQueriesForLanguage("python").map((q) => q.id),
		).not.toContain("disabled-example");
	});

	it("detects disabled query paths independent of path separator", () => {
		expect(getQueryLanguageKey("typescript-disabled")).toBe("typescript");
		expect(
			isDisabledQueryFilePath(
				"rules/tree-sitter-queries/typescript-disabled/ts-path-traversal.yml",
			),
		).toBe(true);
		expect(
			isDisabledQueryFilePath(
				"rules\\tree-sitter-queries\\typescript-disabled\\ts-path-traversal.yml",
			),
		).toBe(true);
		expect(
			isDisabledQueryFilePath(
				"rules/tree-sitter-queries/typescript/console-statement.yml",
			),
		).toBe(false);
	});
});

describe("scalar values drop trailing YAML comments", () => {
	it("keeps a commented post_filter usable as a filter name", async () => {
		const root = makeTempRulesRoot();
		writeRule(
			root,
			"rules/tree-sitter-queries/typescript/commented-scalar.yml",
			`id: commented-scalar
name: Commented Scalar
severity: warning
category: quality
language: typescript
message: "uses # in a quoted message"
post_filter: not_in_test_block  # skip test blocks
query: |
  (identifier) @X
metavars: [X]
`,
		);

		const loader = new TreeSitterQueryLoader();
		await loader.loadQueries(root);
		const query = loader.getQueryById("commented-scalar");
		// Carrying the comment into the name meant the filter never resolved and
		// the rule reported every raw match unfiltered.
		expect(query?.post_filter).toBe("not_in_test_block");
		expect(query?.message).toBe("uses # in a quoted message");
	});
});

describe("queriesForLanguage", () => {
	const rule = (id: string, filePath: string): TreeSitterQuery =>
		({ id, filePath }) as TreeSitterQuery;

	const map = new Map<string, TreeSitterQuery[]>([
		[
			"typescript",
			[
				rule("ts-on", "rules/tree-sitter-queries/typescript/on.yml"),
				rule("ts-off", "rules/tree-sitter-queries/typescript-disabled/off.yml"),
			],
		],
		["tsx", [rule("tsx-own", "rules/tree-sitter-queries/tsx/own.yml")]],
		[
			"javascript",
			[rule("js-own", "rules/tree-sitter-queries/javascript/own.yml")],
		],
	]);

	it("never returns a rule from a -disabled directory", () => {
		expect(queriesForLanguage(map, "typescript").map((q) => q.id)).toEqual([
			"ts-on",
		]);
	});

	it("gives tsx the typescript rule set on top of its own", () => {
		expect(queriesForLanguage(map, "tsx").map((q) => q.id)).toEqual([
			"tsx-own",
			"ts-on",
		]);
	});

	it("does NOT give javascript the typescript rule set", () => {
		// Those rules are written against the typescript grammar: on a javascript
		// tree `duplicate-function-arg` alone reported 59 phantom duplicates.
		expect(queriesForLanguage(map, "javascript").map((q) => q.id)).toEqual([
			"js-own",
		]);
	});
});

describe("ruleSourceLanguages / ruleFilesForLanguage (#878)", () => {
	it("mirrors the rule-set composition queriesForLanguage applies", () => {
		// tsx is the one typescript-rule heir; javascript is deliberately not.
		expect(ruleSourceLanguages("tsx")).toEqual(["tsx", "typescript"]);
		expect(ruleSourceLanguages("typescript")).toEqual(["typescript"]);
		expect(ruleSourceLanguages("javascript")).toEqual(["javascript"]);
		expect(ruleSourceLanguages("python")).toEqual(["python"]);
	});

	it("enumerates project-local rule files across every rule-source language", () => {
		const root = makeTempRulesRoot();
		writeRule(root, "rules/tree-sitter-queries/tsx/own.yml", "id: tsx-own\n");
		writeRule(
			root,
			"rules/tree-sitter-queries/typescript/inherited.yml",
			"id: ts-rule\n",
		);
		writeRule(
			root,
			"rules/tree-sitter-queries/python/unrelated.yml",
			"id: py-rule\n",
		);
		// Non-.yml files never load, so they must not fingerprint either.
		writeRule(
			root,
			"rules/tree-sitter-queries/typescript/notes.txt",
			"not a rule\n",
		);

		const files = ruleFilesForLanguage("tsx", root).map((f) =>
			f.replaceAll("\\", "/"),
		);
		expect(files.some((f) => f.endsWith("tsx/own.yml"))).toBe(true);
		expect(files.some((f) => f.endsWith("typescript/inherited.yml"))).toBe(
			true,
		);
		expect(files.some((f) => f.endsWith("python/unrelated.yml"))).toBe(false);
		expect(files.some((f) => f.endsWith("notes.txt"))).toBe(false);

		// A non-heir language fingerprints only its own directory.
		const pyFiles = ruleFilesForLanguage("python", root).map((f) =>
			f.replaceAll("\\", "/"),
		);
		expect(pyFiles.some((f) => f.endsWith("python/unrelated.yml"))).toBe(true);
		expect(pyFiles.some((f) => f.endsWith("typescript/inherited.yml"))).toBe(
			false,
		);
	});
});

/**
 * #2636 (the #2626 class sweep's tree-sitter leg): `ruleFilesForLanguage`
 * resolving zero files is NORMAL for a language nobody has authored bundled
 * queries for (cobol, plsql — disabled by design, see
 * `tree-sitter-shared.ts`'s `TYPESCRIPT_RULE_HEIRS` neighbourhood) and a BUG
 * when the bundled `rules/tree-sitter-queries` root itself was relocated out
 * from under the package. The two must never be confused: a record fires
 * only when the shared ROOT is unhealthy, never merely because ONE
 * language's own subdirectory is empty.
 */
describe("ruleFilesForLanguage — bundled root health (#2636)", () => {
	const notified: Array<{ message: string; level: string | undefined }> = [];

	beforeEach(() => {
		notified.length = 0;
		resetDegradationLedger();
		wireUserNotifier(() => (message, level) => {
			notified.push({ message, level });
		});
	});

	afterEach(() => {
		resetUserNotifier();
		resetDegradationLedger();
		vi.restoreAllMocks();
	});

	function degradationGroup() {
		return getDegradationSummary().find(
			(g) => g.kind === "tree-sitter-queries-dir-missing",
		);
	}

	it("records nothing for cobol: zero files, but the REAL bundled root is healthy (no queries authored by design)", () => {
		const root = makeTempRulesRoot();
		expect(ruleFilesForLanguage("cobol", root)).toEqual([]);
		expect(degradationGroup()).toBeUndefined();
		expect(notified).toHaveLength(0);
	});

	it("never classifies the bundled root on the common, non-empty path (typescript)", () => {
		const classifySpy = vi.spyOn(
			bundledResourceHealth,
			"classifyBundledResourceDir",
		);
		const root = makeTempRulesRoot();
		expect(ruleFilesForLanguage("typescript", root).length).toBeGreaterThan(0);
		expect(classifySpy).not.toHaveBeenCalled();
	});

	it("records a bounded degradation + notify when the bundled root is actually gone", () => {
		const classifySpy = vi
			.spyOn(bundledResourceHealth, "classifyBundledResourceDir")
			.mockReturnValue({ status: "absent" });
		const root = makeTempRulesRoot();

		expect(ruleFilesForLanguage("cobol", root)).toEqual([]);

		expect(classifySpy).toHaveBeenCalledWith(BUNDLED_QUERIES_ROOT);
		const group = degradationGroup();
		expect(group).toBeDefined();
		expect(group?.latestReasons.at(-1)?.subject).toBe(BUNDLED_QUERIES_ROOT);
		expect(notified).toHaveLength(1);
		expect(notified[0].message).toContain(
			"bundled tree-sitter query rules unavailable",
		);
	});

	it("collapses every zero-file language into ONE ledger row, not one per language", () => {
		vi.spyOn(
			bundledResourceHealth,
			"classifyBundledResourceDir",
		).mockReturnValue({ status: "absent" });
		const root = makeTempRulesRoot();

		ruleFilesForLanguage("cobol", root);
		ruleFilesForLanguage("plsql", root);
		ruleFilesForLanguage("cobol", root);

		expect(notified).toHaveLength(1);
		expect(degradationGroup()?.count).toBe(3);
		expect(
			getDegradationSummary().filter(
				(g) => g.kind === "tree-sitter-queries-dir-missing",
			),
		).toHaveLength(1);
	});
});
