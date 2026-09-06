#!/usr/bin/env node
/**
 * Release-QA runner (#2606) — witness the feature × modality matrix against a
 * REAL pi before a tag is cut.
 *
 * WHY THIS EXISTS
 * #2587: the four shipped skills were suspected of never registering for four
 * releases because no check ever asked a real pi what it loaded. The unit suite
 * and the nightly smokes are per-seam; nothing composed them into a release
 * verdict with COUNTED coverage, so a missing row read as absence rather than
 * arithmetic. This runner is that composition.
 *
 * WHAT IT DOES
 *   1. Reads `docs/release-qa-baseline.md` — the matrix is the DOCUMENT, not a
 *      copy of it in here. Every row id there must have a probe below and vice
 *      versa (`tests/scripts/release-qa.test.ts` enforces the tie).
 *   2. Packs the working tree (`npm pack`) — or takes `--from npm:pi-lens@X` to
 *      QA a published release instead — and installs it into a SCRATCH project.
 *   3. Installs that package into a scratch `pi` (`HOME`, `PI_LENS_HOME` and
 *      `PILENS_DATA_DIR` all pinned inside the scratch root: this never touches
 *      the maintainer's real `~/.pi` or `~/.pi-lens` — AGENTS.md probe hygiene,
 *      #2506).
 *   4. Drives each row's entry point — the command or RPC a USER path takes,
 *      never a raw internal function — and writes `release-qa-report.md` plus
 *      one witness file per row under `release-qa-evidence/`.
 *
 * OUTCOMES
 * Every discovered row ends PASS / FAIL(cause) / UNTESTED(reason) /
 * SKIPPED(reason), and the four partition the discovered set — the report
 * asserts `discovered = pass + fail + untested + skipped`. An async row that
 * does not reach a terminal state before its polling cap expires UNTESTED,
 * never PASS. If pi cannot boot the run is BLOCKED and NO ship verdict is
 * issued.
 *
 * Exit codes: 0 ship · 1 do not ship · 2 ship with caveats · 3 BLOCKED ·
 * 4 usage/self-check error.
 *
 * USAGE
 *   node scripts/release-qa.mjs [options]
 *     --pi <path>          pi binary to drive (default: `pi` on PATH)
 *     --from <source>      `tree` (default: npm pack this repo) or
 *                          `npm:pi-lens@<version>` to QA a published release
 *     --baseline <path>    default docs/release-qa-baseline.md
 *     --out <dir>          where the report + evidence land (default: cwd)
 *     --poll-cap-ms <n>    cap for polled async rows (default 120000)
 *     --git-ref <ref>      enable the git-install row against this pushed ref
 *     --keep               leave the scratch root on disk
 *
 * Node-only, no new dependency. Every spawn is shell-free (execFile/spawn with
 * an argv array) per AGENTS.md.
 */

import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { gitExecFileSync } from "./lib/git-fixture-env.mjs";
import { parseTable } from "./lib/md-matrix.mjs";

// ===========================================================================
// Pure core — parsing, outcome rules, arithmetic, rendering.
// Exported so `tests/scripts/release-qa.test.ts` can hold them without
// spawning a real pi (that is this runner's job, and install-smoke's lane).
// ===========================================================================

/**
 * Short, schema-stable marker for the baseline's matrix table. Deliberately the
 * first two columns only: a marker naming a column that a later revision adds
 * or renames would stop finding the table and the runner would silently report
 * zero discovered rows.
 */
export const BASELINE_TABLE_MARKER = "| row id | feature |";

/** The matrix columns, in order. A baseline missing one is a hard error. */
export const BASELINE_COLUMNS = Object.freeze([
	"row id",
	"feature",
	"modality",
	"entry point",
	"pass criterion",
	"witness",
	"reuse",
]);

export const OUTCOME = Object.freeze({
	PASS: "PASS",
	FAIL: "FAIL",
	UNTESTED: "UNTESTED",
	SKIPPED: "SKIPPED",
});

/**
 * Parse the baseline matrix into ordered row records.
 *
 * Returns `{ rows, errors }`. `errors` is non-empty when the document cannot be
 * trusted as a row list — a missing table, a renamed/missing column, a blank id,
 * or a duplicate id. The caller treats any error as a self-check failure and
 * refuses to run: a matrix the runner half-understood would under-report
 * coverage while looking healthy, which is the exact failure #2606 exists to
 * end.
 *
 * @param {string} text  contents of docs/release-qa-baseline.md
 */
export function parseBaselineRows(text) {
	const table = parseTable(String(text ?? ""), BASELINE_TABLE_MARKER);
	if (!table) {
		return {
			rows: [],
			errors: [`no matrix table found (marker ${BASELINE_TABLE_MARKER})`],
		};
	}
	const errors = [];
	for (const column of BASELINE_COLUMNS) {
		if (!table.header.includes(column)) {
			errors.push(`baseline table is missing the "${column}" column`);
		}
	}
	if (errors.length > 0) return { rows: [], errors };

	const index = (name) => table.header.indexOf(name);
	const rows = [];
	const seen = new Set();
	for (const cells of table.rows) {
		const id = cells[index("row id")] ?? "";
		if (id === "") {
			errors.push(`row ${rows.length + 1} has a blank row id`);
			continue;
		}
		if (seen.has(id)) {
			errors.push(`duplicate row id "${id}"`);
			continue;
		}
		seen.add(id);
		rows.push({
			id,
			feature: cells[index("feature")] ?? "",
			modality: cells[index("modality")] ?? "",
			entryPoint: cells[index("entry point")] ?? "",
			passCriterion: cells[index("pass criterion")] ?? "",
			witness: cells[index("witness")] ?? "",
			reuse: cells[index("reuse")] ?? "",
		});
	}
	if (rows.length === 0 && errors.length === 0) {
		errors.push("baseline matrix has no rows");
	}
	return { rows, errors };
}

/**
 * The outcome rules, as one total function over a probe's self-reported status.
 *
 * `expired` is the load-bearing one: a polled row whose cap elapsed before a
 * terminal state is UNTESTED, NEVER PASS. A runner that lets a timeout read as
 * success reports a green release it never witnessed.
 *
 * `unimplemented` is the second: a baseline row with no probe is UNTESTED with
 * that reason, so an unimplemented row is arithmetic rather than silence.
 *
 * @param {{ status?: string, detail?: string }} probe
 * @returns {{ outcome: string, detail: string }}
 */
export function classifyProbe(probe) {
	const detail = String(probe?.detail ?? "").trim();
	switch (probe?.status) {
		case "pass":
			return { outcome: OUTCOME.PASS, detail };
		case "fail":
			return { outcome: OUTCOME.FAIL, detail: detail || "no cause recorded" };
		case "error":
			return { outcome: OUTCOME.FAIL, detail: detail || "probe threw" };
		case "expired":
			return {
				outcome: OUTCOME.UNTESTED,
				detail: detail || "polling cap expired before a terminal state",
			};
		case "unreachable":
			return {
				outcome: OUTCOME.SKIPPED,
				detail: detail || "unreachable in this run",
			};
		case "unimplemented":
			return {
				outcome: OUTCOME.UNTESTED,
				detail: detail || "no runner implementation for this row",
			};
		case "blocked":
			return {
				outcome: OUTCOME.UNTESTED,
				detail: detail || "run BLOCKED before this row was attempted",
			};
		default:
			return {
				outcome: OUTCOME.UNTESTED,
				detail: `unknown probe status ${JSON.stringify(probe?.status ?? null)}`,
			};
	}
}

/** `PASS`, or `FAIL(cause)` / `UNTESTED(reason)` / `SKIPPED(reason)`. */
export function formatOutcome(result) {
	if (result.outcome === OUTCOME.PASS) return OUTCOME.PASS;
	return `${result.outcome}(${result.detail || "no reason recorded"})`;
}

/**
 * Counted coverage.
 *
 * `discovered` is the count of rows the BASELINE enumerated, passed in
 * separately and deliberately: taking it from `results.length` would make the
 * balance check below tautological, and an inert guard is worse than none. A
 * discovered row that produced no result — a `continue` added to the loop, a
 * probe map keyed wrong — then shows up as an ARITHMETIC MISMATCH instead of
 * quietly shrinking the denominator, which is the whole point of counting
 * coverage rather than claiming it.
 *
 * `rows` counts the rows this run actually ATTEMPTED: a blocked run attempts
 * none, so `rows` reads 0 rather than implying work that never happened.
 *
 * @param {ReadonlyArray<{ outcome: string, implemented?: boolean }>} results
 * @param {number} [discoveredCount]  rows enumerated in the baseline
 */
export function coverageArithmetic(results, discoveredCount) {
	const list = results ?? [];
	const count = (outcome) => list.filter((r) => r.outcome === outcome).length;
	const pass = count(OUTCOME.PASS);
	const fail = count(OUTCOME.FAIL);
	const untested = count(OUTCOME.UNTESTED);
	const skipped = count(OUTCOME.SKIPPED);
	const discovered =
		typeof discoveredCount === "number" ? discoveredCount : list.length;
	return {
		discovered,
		rows: list.filter((r) => r.implemented !== false).length,
		pass,
		fail,
		untested,
		skipped,
		balanced: pass + fail + untested + skipped === discovered,
	};
}

/** The single arithmetic line the skill quotes. */
export function renderCoverageLine(coverage) {
	const balance = coverage.balanced
		? ""
		: "  ** ARITHMETIC MISMATCH — a discovered row produced no outcome **";
	return (
		`coverage: discovered ${coverage.discovered} / rows ${coverage.rows} / ` +
		`untested ${coverage.untested}  ` +
		`(pass ${coverage.pass} · fail ${coverage.fail} · ` +
		`untested ${coverage.untested} · skipped ${coverage.skipped})${balance}`
	);
}

/**
 * The ship line. BLOCKED short-circuits everything: a run where pi could not
 * boot witnessed nothing, so it gets NO ship verdict — reporting it as
 * "do not ship" would be a verdict the run did not earn, and reporting it as
 * anything else would be worse.
 *
 * @param {ReadonlyArray<{ id: string, outcome: string, detail: string }>} results
 * @param {{ blocked?: boolean, blockedReason?: string }} [options]
 */
export function shipVerdict(results, options = {}) {
	if (options.blocked) {
		return {
			verdict: "BLOCKED",
			reason: options.blockedReason || "pi could not boot",
			caveats: [],
		};
	}
	const list = results ?? [];
	const failed = list.filter((r) => r.outcome === OUTCOME.FAIL);
	if (failed.length > 0) {
		return {
			verdict: "DO-NOT-SHIP",
			reason: `${failed.length} row(s) FAILED`,
			caveats: failed.map((r) => `${r.id}: ${r.detail}`),
		};
	}
	const caveats = list.filter(
		(r) => r.outcome === OUTCOME.UNTESTED || r.outcome === OUTCOME.SKIPPED,
	);
	if (caveats.length > 0) {
		return {
			verdict: "SHIP-WITH-CAVEATS",
			reason: `${caveats.length} row(s) produced no witness`,
			caveats: caveats.map((r) => `${r.id} ${formatOutcome(r)}`),
		};
	}
	return {
		verdict: "SHIP",
		reason: "every discovered row PASSED with a witness",
		caveats: [],
	};
}

/** Exit code per verdict. 4 is reserved for usage/self-check errors. */
export function verdictExitCode(verdict) {
	switch (verdict) {
		case "SHIP":
			return 0;
		case "DO-NOT-SHIP":
			return 1;
		case "SHIP-WITH-CAVEATS":
			return 2;
		case "BLOCKED":
			return 3;
		default:
			return 4;
	}
}

/**
 * The report. Each row line carries its witness PATH and the excerpt that SHOWS
 * the asserted result — a witness that merely exists is not a witness.
 */
export function renderReport({
	rows,
	results,
	coverage,
	verdict,
	context = {},
}) {
	const byId = new Map((results ?? []).map((r) => [r.id, r]));
	const lines = [];
	lines.push("# Release-QA report");
	lines.push("");
	for (const [key, value] of Object.entries(context)) {
		lines.push(`- **${key}**: ${value}`);
	}
	lines.push("");
	lines.push(`## Verdict: ${verdict.verdict}`);
	lines.push("");
	lines.push(verdict.reason);
	if (verdict.verdict === "BLOCKED") {
		lines.push("");
		lines.push(
			"No ship verdict is issued for a blocked run: nothing was witnessed.",
		);
	}
	for (const caveat of verdict.caveats) lines.push(`- ${caveat}`);
	lines.push("");
	lines.push("```");
	lines.push(renderCoverageLine(coverage));
	lines.push("```");
	lines.push("");
	lines.push("## Rows");
	lines.push("");
	lines.push(
		"| row id | modality | outcome | witness | what the witness shows |",
	);
	lines.push("| --- | --- | --- | --- | --- |");
	for (const row of rows ?? []) {
		const result = byId.get(row.id);
		const outcome = result ? formatOutcome(result) : "UNTESTED(not run)";
		const witness = result?.witnessPath ?? "—";
		const shows = (result?.shows ?? "—").replace(/\s*\|\s*/g, " / ");
		lines.push(
			`| ${row.id} | ${row.modality} | ${outcome} | ${witness} | ${shows} |`,
		);
	}
	lines.push("");
	return `${lines.join("\n")}\n`;
}

// ===========================================================================
// Driver — the impure half.
// ===========================================================================

const IS_WINDOWS = process.platform === "win32";
const NPM_BIN = IS_WINDOWS ? "npm.cmd" : "npm";
const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const DEFAULT_POLL_CAP_MS = 120_000;
const RPC_TIMEOUT_MS = 60_000;
const MCP_CALL_TIMEOUT_MS = 180_000;

export function parseArgs(argv) {
	const opts = {
		pi: "pi",
		from: "tree",
		baseline: path.join(REPO_ROOT, "docs", "release-qa-baseline.md"),
		out: process.cwd(),
		pollCapMs: DEFAULT_POLL_CAP_MS,
		gitRef: undefined,
		keep: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--pi") opts.pi = argv[++i];
		else if (arg === "--from") opts.from = argv[++i];
		else if (arg === "--baseline") opts.baseline = argv[++i];
		else if (arg === "--out") opts.out = argv[++i];
		else if (arg === "--poll-cap-ms") opts.pollCapMs = Number(argv[++i]);
		else if (arg === "--git-ref") opts.gitRef = argv[++i];
		else if (arg === "--keep") opts.keep = true;
		else throw new Error(`unknown option: ${arg}`);
	}
	return opts;
}

function log(message) {
	console.log(`[release-qa] ${message}`);
}

/** Shell-free `npm` with an argv array. */
function npm(args, cwd, timeoutMs = 600_000) {
	return execFileSync(NPM_BIN, args, {
		cwd,
		encoding: "utf8",
		timeout: timeoutMs,
	});
}

/**
 * The scratch environment every child process below runs under. HOME steers
 * pi's own `~/.pi`; PI_LENS_HOME and PILENS_DATA_DIR steer pi-lens's logs,
 * ledgers and caches. All three land inside the scratch root, so a run can
 * never write into the maintainer's real dirs (#2506).
 */
function scratchEnv(scratchRoot, extra = {}) {
	const home = path.join(scratchRoot, "home");
	return {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		PI_LENS_HOME: path.join(home, ".pi-lens"),
		PILENS_DATA_DIR: path.join(home, ".pilens-data"),
		ANTHROPIC_API_KEY:
			process.env.ANTHROPIC_API_KEY || "sk-ant-dummy-release-qa",
		...extra,
	};
}

/**
 * The fixture project every row is witnessed against.
 *
 * `.pi-lens.json` carries `lsp.enabled` DELIBERATELY: it is a global-only
 * setting, so placing it at project tier is a real, deterministic
 * "input silently ignored" event. That one file therefore serves two rows —
 * config-provenance (it is a contributing document) and degradation-visible
 * (it produces a `config-ignored` degradation naming this file). Every other
 * ignored-input trigger I probed either was accepted as ordinary provenance
 * (an unknown key) or needed a network failure to reproduce (auto-install).
 */
function setUpFixture(projectDir) {
	fs.mkdirSync(projectDir, { recursive: true });
	fs.writeFileSync(
		path.join(projectDir, "a.ts"),
		"export function releaseQaFixtureSymbol(n: number): number {\n\treturn n + 1;\n}\n",
	);
	fs.writeFileSync(
		path.join(projectDir, "package.json"),
		'{ "name": "release-qa-fixture", "version": "1.0.0", "type": "module" }\n',
	);
	fs.writeFileSync(
		path.join(projectDir, ".pi-lens.json"),
		'{\n\t"lsp": { "enabled": true }\n}\n',
	);
	gitExecFileSync(["init", "-q"], { cwd: projectDir });
	gitExecFileSync(["config", "user.email", "t@t.t"], { cwd: projectDir });
	gitExecFileSync(["config", "user.name", "t"], { cwd: projectDir });
	gitExecFileSync(["add", "-A"], { cwd: projectDir });
	gitExecFileSync(["commit", "-qm", "init"], { cwd: projectDir });
}

/**
 * Drive one headless `pi --mode rpc` session and capture the `get_commands`
 * response plus any `extension_error` events. This is the #2589 mechanism —
 * the same JSONL framing and the same command `scripts/rpc-load-check.mjs`
 * uses in install-smoke's `pi-load` job — captured once and asserted on by two
 * rows rather than run twice.
 */
function captureGetCommands({ piBin, cwd, env, timeoutMs = RPC_TIMEOUT_MS }) {
	return new Promise((resolve) => {
		let child;
		try {
			child = spawn(piBin, ["--mode", "rpc", "--no-session"], {
				cwd,
				stdio: ["pipe", "pipe", "pipe"],
				env,
			});
		} catch (err) {
			resolve({ ok: false, reason: `spawn failed: ${err?.message || err}` });
			return;
		}
		const extensionErrors = [];
		const stderr = [];
		let buf = "";
		let settled = false;
		const finish = (value) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			try {
				child.kill("SIGKILL");
			} catch {}
			resolve(value);
		};
		const timer = setTimeout(
			() =>
				finish({
					ok: false,
					reason: `no get_commands response within ${timeoutMs}ms`,
					extensionErrors,
					stderr: stderr.join(""),
				}),
			timeoutMs,
		);
		child.stderr.on("data", (chunk) => stderr.push(chunk.toString()));
		child.stdout.on("data", (chunk) => {
			buf += chunk.toString();
			let i = buf.indexOf("\n");
			while (i >= 0) {
				const line = buf.slice(0, i).replace(/\r$/, "");
				buf = buf.slice(i + 1);
				i = buf.indexOf("\n");
				if (!line.trim()) continue;
				let message;
				try {
					message = JSON.parse(line);
				} catch {
					continue;
				}
				if (
					(message.type === "event" && message.event === "extension_error") ||
					message.type === "extension_error"
				) {
					extensionErrors.push(message);
				}
				if (message.type === "response" && message.command === "get_commands") {
					finish({
						ok: true,
						commands: message.data?.commands ?? [],
						extensionErrors,
						raw: message,
					});
				}
			}
		});
		child.on("error", (err) =>
			finish({ ok: false, reason: `pi error: ${err?.message || err}` }),
		);
		child.on("exit", (code) =>
			finish({
				ok: false,
				reason: `pi exited early (code ${code})`,
				extensionErrors,
				stderr: stderr.join(""),
			}),
		);
		// Extensions register asynchronously; ask once they have had a moment.
		setTimeout(() => {
			try {
				child.stdin.write(`${JSON.stringify({ type: "get_commands" })}\n`);
			} catch {}
		}, 3000);
	});
}

/** A newline-delimited JSON-RPC client for the pi-lens MCP stdio server. */
class McpSession {
	constructor(serverJs, cwd, env) {
		this.child = spawn(process.execPath, [serverJs], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env,
		});
		this.pending = new Map();
		this.nextId = 1;
		this.stderr = [];
		this.buf = "";
		this.child.stderr.on("data", (chunk) => this.stderr.push(chunk.toString()));
		this.child.stdout.on("data", (chunk) => {
			this.buf += chunk.toString();
			let i = this.buf.indexOf("\n");
			while (i >= 0) {
				const line = this.buf.slice(0, i).trim();
				this.buf = this.buf.slice(i + 1);
				i = this.buf.indexOf("\n");
				if (!line) continue;
				let message;
				try {
					message = JSON.parse(line);
				} catch {
					continue;
				}
				const waiter = this.pending.get(message.id);
				if (waiter) {
					this.pending.delete(message.id);
					waiter.resolve(message);
				}
			}
		});
		this.exited = new Promise((resolve) => {
			this.child.on("exit", (code) => {
				for (const [, waiter] of this.pending) {
					waiter.resolve({ error: { message: `server exited (${code})` } });
				}
				this.pending.clear();
				resolve(code);
			});
		});
	}

	request(method, params, timeoutMs = MCP_CALL_TIMEOUT_MS) {
		const id = this.nextId++;
		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				resolve({ error: { message: `timeout after ${timeoutMs}ms` } });
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (message) => {
					clearTimeout(timer);
					resolve(message);
				},
			});
			try {
				this.child.stdin.write(
					`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
				);
			} catch (err) {
				clearTimeout(timer);
				this.pending.delete(id);
				resolve({ error: { message: `write failed: ${err?.message || err}` } });
			}
		});
	}

	notify(method, params) {
		try {
			this.child.stdin.write(
				`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`,
			);
		} catch {}
	}

	/** The first text block of a tools/call result, or an error marker. */
	async callToolText(name, args, timeoutMs) {
		const response = await this.request(
			"tools/call",
			{ name, arguments: args },
			timeoutMs,
		);
		if (response.error) {
			return { ok: false, text: `JSON-RPC error: ${response.error.message}` };
		}
		const text = response.result?.content?.[0]?.text ?? "";
		return { ok: response.result?.isError !== true, text: String(text) };
	}

	async close() {
		try {
			this.child.kill("SIGTERM");
		} catch {}
		await Promise.race([
			this.exited,
			new Promise((resolve) => setTimeout(resolve, 5000)),
		]);
		try {
			this.child.kill("SIGKILL");
		} catch {}
	}
}

/**
 * Poll `attempt` until it reports terminal, or the cap elapses.
 *
 * The cap is a real deadline measured against the wall clock, and expiry
 * returns `{ status: "expired" }` — which `classifyProbe` turns into UNTESTED.
 * Nothing here can turn a timeout into a pass.
 */
export async function pollToTerminal(attempt, { capMs, intervalMs = 5000 }) {
	const deadline = Date.now() + capMs;
	let last = { terminal: false, detail: "never attempted" };
	let attempts = 0;
	while (Date.now() < deadline) {
		attempts++;
		last = await attempt();
		if (last.terminal) return { status: "terminal", attempts, value: last };
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		await new Promise((resolve) =>
			setTimeout(resolve, Math.min(intervalMs, remaining)),
		);
	}
	return {
		status: "expired",
		attempts,
		value: last,
		detail:
			`polling cap ${capMs}ms expired after ${attempts} attempt(s) without a ` +
			`terminal state — last: ${last.detail}`,
	};
}

// --- Row probes ------------------------------------------------------------
//
// One entry per baseline row id. A row id present here but absent from
// docs/release-qa-baseline.md (or the reverse) is a self-check failure, not a
// silently skipped row — the matrix document is the single source of truth for
// the row list and this map may never become a second copy of it.

/** @param {any} ctx */
const ROW_PROBES = {
	"pack-skills-payload": async (ctx) => {
		const listing = ctx.packListing;
		if (!listing) {
			return { status: "fail", detail: "no pack listing was captured" };
		}
		const files = (listing.files ?? []).map((f) => f.path ?? "");
		const skillDocs = files.filter((p) => /^skills\/.*\/SKILL\.md$/.test(p));
		const hasEntry = files.includes("dist/index.js");
		const shows = `dist/index.js present=${hasEntry}; SKILL.md in pack=${skillDocs.length}`;
		return {
			status: hasEntry && skillDocs.length >= 4 ? "pass" : "fail",
			detail: shows,
			shows,
			witness: { ext: "json", content: JSON.stringify(listing, null, 2) },
		};
	},

	"install-selftest": async (ctx) => {
		const selftest = path.join(
			ctx.installedPkgDir,
			"scripts",
			"install-selftest.mjs",
		);
		if (!fs.existsSync(selftest)) {
			return {
				status: "fail",
				detail: `install-selftest.mjs is not in the installed package (${selftest})`,
			};
		}
		let stdout = "";
		let code = 0;
		try {
			stdout = execFileSync(process.execPath, [selftest, "--allow-soft"], {
				cwd: ctx.projectDir,
				encoding: "utf8",
				env: ctx.env,
				timeout: 300_000,
			});
		} catch (err) {
			stdout = `${err?.stdout ?? ""}${err?.stderr ?? ""}`;
			code = typeof err?.status === "number" ? err.status : 1;
		}
		const failLines = stdout
			.split(/\r?\n/)
			.filter((line) => line.includes("[FAIL]"));
		const summary =
			stdout.split(/\r?\n/).find((line) => line.startsWith("selftest:")) ?? "";
		const shows = `exit ${code}; ${failLines.length} [FAIL] line(s); ${summary}`;
		return {
			status: code === 0 && failLines.length === 0 ? "pass" : "fail",
			detail: shows,
			shows,
			witness: { ext: "txt", content: stdout },
		};
	},

	"skills-registered": async (ctx) => {
		const capture = ctx.rpc;
		if (!capture?.ok) {
			return { status: "fail", detail: capture?.reason ?? "no RPC capture" };
		}
		const skills = capture.commands.filter((c) => c.source === "skill");
		const inPackage = skills.filter((c) =>
			String(c.sourceInfo?.path ?? "").startsWith(ctx.installedPkgDir),
		);
		const shows =
			`${skills.length} skill command(s): ` +
			`${skills.map((c) => c.name).join(", ") || "(none)"}; ` +
			`${inPackage.length} resolved inside the installed package`;
		return {
			status:
				skills.length >= 4 && inPackage.length === skills.length
					? "pass"
					: "fail",
			detail: shows,
			shows,
			witness: {
				ext: "json",
				content: JSON.stringify(capture.raw ?? capture, null, 2),
			},
		};
	},

	"commands-registered": async (ctx) => {
		const capture = ctx.rpc;
		if (!capture?.ok) {
			return { status: "fail", detail: capture?.reason ?? "no RPC capture" };
		}
		const lens = capture.commands.filter(
			(c) =>
				c.source === "extension" && String(c.name ?? "").startsWith("lens-"),
		);
		const errors = capture.extensionErrors ?? [];
		const shows =
			`${lens.length} lens-* command(s): ${lens.map((c) => c.name).join(", ") || "(none)"}; ` +
			`${errors.length} extension_error event(s)`;
		return {
			status: lens.length >= 1 && errors.length === 0 ? "pass" : "fail",
			detail: shows,
			shows,
			witness: {
				ext: "json",
				content: JSON.stringify(
					{ lensCommands: lens, extensionErrors: errors },
					null,
					2,
				),
			},
		};
	},

	"mcp-tools-registered": async (ctx) => {
		const listed = ctx.mcpTools;
		if (!listed?.ok) {
			return {
				status: "fail",
				detail: listed?.reason ?? "no tools/list result",
			};
		}
		const names = listed.names;
		const required = [
			"pilens_analyze",
			"pilens_diagnostics",
			"pilens_turn_end",
			"pilens_lsp_navigation",
			"pilens_health",
		];
		const missing = required.filter((n) => !names.includes(n));
		const misnamed = names.filter((n) => !n.startsWith("pilens_"));
		const shows =
			`${names.length} tool(s) advertised; ${missing.length} required missing ` +
			`(${missing.join(", ") || "none"}); ${misnamed.length} not pilens_* ` +
			`(${misnamed.join(", ") || "none"})`;
		return {
			status: missing.length === 0 && misnamed.length === 0 ? "pass" : "fail",
			detail: shows,
			shows,
			witness: { ext: "json", content: JSON.stringify(names, null, 2) },
		};
	},

	"mcp-diagnostics-full": async (ctx) => {
		const mcp = ctx.mcp;
		if (!mcp) return { status: "fail", detail: "no MCP session" };
		// The genuinely async row: the full scan runs project-wide analyzers, so
		// it is polled to a terminal state and expiry is UNTESTED, never PASS.
		let lastText = "";
		const polled = await pollToTerminal(
			async () => {
				const result = await mcp.callToolText(
					"pilens_diagnostics",
					{ mode: "full", refreshRunners: "cheap" },
					ctx.pollCapMs,
				);
				lastText = result.text;
				const summary = /Summary \((\d+) files? diagnosed this session\)/.exec(
					result.text,
				);
				const diagnosed = summary ? Number(summary[1]) : 0;
				return {
					terminal: result.ok && diagnosed >= 1,
					detail: result.ok
						? `summary reports ${diagnosed} file(s) diagnosed`
						: `tool error: ${result.text.slice(0, 200)}`,
				};
			},
			{ capMs: ctx.pollCapMs, intervalMs: 5000 },
		);
		const witness = { ext: "txt", content: lastText };
		if (polled.status === "expired") {
			return { status: "expired", detail: polled.detail, witness };
		}
		return {
			status: "pass",
			detail: polled.value.detail,
			shows: polled.value.detail,
			witness,
		};
	},

	"mcp-turn-end": async (ctx) => {
		const mcp = ctx.mcp;
		if (!mcp) return { status: "fail", detail: "no MCP session" };
		const result = await mcp.callToolText("pilens_turn_end", {
			files: ["a.ts"],
		});
		const match = /Turn-end over (\d+) file\(s\)\./.exec(result.text);
		const covered = match ? Number(match[1]) : 0;
		const shows = result.ok
			? `turn-end ran over ${covered} file(s)`
			: `tool error: ${result.text.slice(0, 200)}`;
		return {
			status: result.ok && covered >= 1 ? "pass" : "fail",
			detail: shows,
			shows,
			witness: { ext: "txt", content: result.text },
		};
	},

	"mcp-lsp-navigation": async (ctx) => {
		const mcp = ctx.mcp;
		if (!mcp) return { status: "fail", detail: "no MCP session" };
		const result = await mcp.callToolText("pilens_lsp_navigation", {
			operation: "documentSymbol",
			path: "a.ts",
		});
		const named = result.text.includes("releaseQaFixtureSymbol");
		const shows = named
			? "documentSymbol answered with releaseQaFixtureSymbol"
			: `documentSymbol did not name the fixture symbol: ${result.text.slice(0, 200)}`;
		return {
			status: result.ok && named ? "pass" : "fail",
			detail: shows,
			shows,
			witness: { ext: "txt", content: result.text },
		};
	},

	"config-provenance": async (ctx) => {
		const mcp = ctx.mcp;
		if (!mcp) return { status: "fail", detail: "no MCP session" };
		const result = await mcp.callToolText("pilens_effective_config", {
			file: "a.ts",
		});
		const configPath = path.join(ctx.projectDir, ".pi-lens.json");
		const named = result.text.includes(configPath);
		const shows = named
			? `effective config names the fixture's ${configPath} as contributing`
			: `fixture config not named in the provenance: ${result.text.slice(0, 200)}`;
		return {
			status: result.ok && named ? "pass" : "fail",
			detail: shows,
			shows,
			witness: { ext: "txt", content: result.text },
		};
	},

	"degradation-visible": async (ctx) => {
		const mcp = ctx.mcp;
		if (!mcp) return { status: "fail", detail: "no MCP session" };
		const result = await mcp.callToolText("pilens_health", {});
		const line = result.text
			.split(/\r?\n/)
			.find(
				(candidate) =>
					candidate.includes("config-ignored") &&
					candidate.includes(".pi-lens.json"),
			);
		const shows = line
			? `health reports: ${line.trim().slice(0, 200)}`
			: "no config-ignored degradation naming the fixture config in health output";
		return {
			status: result.ok && Boolean(line) ? "pass" : "fail",
			detail: shows,
			shows,
			witness: { ext: "txt", content: result.text },
		};
	},

	"git-install-loads": async (ctx) => {
		if (!ctx.gitRef) {
			return {
				status: "unreachable",
				detail:
					"no --git-ref given; a git: install resolves a PUSHED ref, not the " +
					"working tree, so this row is reachable only once the release ref exists",
			};
		}
		const home = path.join(ctx.scratchRoot, "git-home");
		fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
		fs.writeFileSync(
			path.join(home, ".pi", "agent", "settings.json"),
			JSON.stringify({
				npmCommand: ["npm"],
				defaultProvider: "anthropic",
				defaultModel: "claude-sonnet-4-6",
			}),
		);
		const env = { ...ctx.env, HOME: home, USERPROFILE: home };
		const source = `git:github.com/apmantza/pi-lens#${ctx.gitRef}`;
		let installLog = "";
		try {
			installLog = execFileSync(ctx.piBin, ["install", source], {
				cwd: ctx.projectDir,
				encoding: "utf8",
				env,
				timeout: 900_000,
			});
		} catch (err) {
			const detail = `pi install ${source} failed: ${(err?.stderr || err?.message || err).toString().slice(0, 300)}`;
			return {
				status: "fail",
				detail,
				shows: detail,
				witness: { ext: "txt", content: `${installLog}\n${err?.stdout ?? ""}` },
			};
		}
		const capture = await captureGetCommands({
			piBin: ctx.piBin,
			cwd: ctx.projectDir,
			env,
		});
		if (!capture.ok) {
			return { status: "fail", detail: capture.reason ?? "RPC capture failed" };
		}
		const skills = capture.commands.filter((c) => c.source === "skill");
		const lens = capture.commands.filter(
			(c) =>
				c.source === "extension" && String(c.name ?? "").startsWith("lens-"),
		);
		const shows = `git:${ctx.gitRef} → ${lens.length} lens-* command(s), ${skills.length} skill(s)`;
		return {
			status: lens.length >= 1 && skills.length >= 4 ? "pass" : "fail",
			detail: shows,
			shows,
			witness: {
				ext: "json",
				content: JSON.stringify(capture.raw ?? capture, null, 2),
			},
		};
	},
};

/** Row ids this runner can execute. Exported for the drift guard. */
export function implementedRowIds() {
	return Object.keys(ROW_PROBES).sort();
}

async function main() {
	let opts;
	try {
		opts = parseArgs(process.argv.slice(2));
	} catch (err) {
		console.error(`[release-qa] ${err.message}`);
		process.exit(4);
	}

	const baselineText = fs.readFileSync(opts.baseline, "utf8");
	const { rows, errors } = parseBaselineRows(baselineText);
	if (errors.length > 0) {
		for (const error of errors)
			console.error(`[release-qa] baseline: ${error}`);
		process.exit(4);
	}
	// The tie between the matrix document and this file, checked at run time as
	// well as in the unit suite: a probe for a row the matrix dropped would run
	// invisibly, and a matrix row with no probe must be UNTESTED arithmetic, not
	// an omission.
	const baselineIds = new Set(rows.map((r) => r.id));
	const strayProbes = implementedRowIds().filter((id) => !baselineIds.has(id));
	if (strayProbes.length > 0) {
		console.error(
			`[release-qa] probes with no baseline row: ${strayProbes.join(", ")}`,
		);
		process.exit(4);
	}

	const scratchRoot = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-release-qa-"),
	);
	const home = path.join(scratchRoot, "home");
	fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
	fs.writeFileSync(
		path.join(home, ".pi", "agent", "settings.json"),
		JSON.stringify({
			npmCommand: ["npm"],
			defaultProvider: "anthropic",
			defaultModel: "claude-sonnet-4-6",
		}),
	);
	const env = scratchEnv(scratchRoot);
	const projectDir = path.join(scratchRoot, "proj");
	const evidenceDir = path.join(opts.out, "release-qa-evidence");
	fs.mkdirSync(evidenceDir, { recursive: true });

	log(`scratch root: ${scratchRoot}`);
	log(`HOME / PI_LENS_HOME / PILENS_DATA_DIR pinned under ${home}`);

	let blocked = false;
	let blockedReason = "";
	let packListing = null;
	let installedPkgDir = "";
	let rpc = null;
	let mcp = null;
	let mcpTools = null;
	let installSource = opts.from;

	try {
		setUpFixture(projectDir);

		if (opts.from === "tree") {
			log("packing the working tree (npm pack --json)");
			// --pack-destination keeps the tarball out of the checkout (a stray
			// .tgz in the repo root is a dirty tree the next agent inherits), and
			// the JSON is sliced from the first `[` because the `prepare` script
			// legitimately writes progress to stdout ahead of it (#376's break).
			const packJson = npm(
				["pack", "--json", "--pack-destination", scratchRoot],
				REPO_ROOT,
			);
			const jsonStart = packJson.indexOf("[");
			if (jsonStart < 0) throw new Error("npm pack --json printed no JSON");
			packListing = JSON.parse(packJson.slice(jsonStart))[0];
			installSource = path.join(scratchRoot, packListing.filename);
		} else if (opts.from.startsWith("npm:")) {
			installSource = opts.from.slice("npm:".length);
			log(`QA target is the published ${installSource}`);
		} else {
			throw new Error(`unsupported --from: ${opts.from}`);
		}

		// pi supplies typebox and pi-tui from its own runtime, so nothing vendors
		// them and the standalone MCP server cannot load without them. This reuses
		// the repo's own answer to that (#1926) rather than re-listing the
		// packages here — the list and the ranges stay in one place.
		const supplyArgs = execFileSync(
			process.execPath,
			[
				path.join(REPO_ROOT, "scripts", "supply-host-provided-deps.mjs"),
				"--install-args",
			],
			{ encoding: "utf8" },
		)
			.trim()
			.split(/\s+/)
			.filter(Boolean);

		// ONE install, deliberately: npm reconciles the tree against the fixture's
		// package.json on every run, so installing the candidate and the
		// host-provided peers in two `--no-save` passes prunes the first one back
		// out (observed: "Path does not exist" from `pi install` on a directory
		// that existed moments earlier).
		log(
			`installing ${installSource} into the scratch project ` +
				`(with host-provided peers ${supplyArgs.join(" ")})`,
		);
		npm(
			["install", "--no-audit", "--no-fund", installSource, ...supplyArgs],
			projectDir,
		);
		installedPkgDir = path.join(projectDir, "node_modules", "pi-lens");
		if (!fs.existsSync(installedPkgDir)) {
			throw new Error(`pi-lens is not installed at ${installedPkgDir}`);
		}

		if (opts.from !== "tree") {
			// A published release is QA'd as shipped, so the pack listing has to be
			// derived from the installed tree rather than from `npm pack`.
			packListing = {
				filename: `${installSource} (as installed)`,
				files: listInstalledFiles(installedPkgDir),
			};
		}

		log(`pi install ${installedPkgDir}`);
		execFileSync(opts.pi, ["install", installedPkgDir], {
			cwd: projectDir,
			encoding: "utf8",
			env,
			timeout: 600_000,
		});

		log("driving pi --mode rpc (get_commands)");
		rpc = await captureGetCommands({ piBin: opts.pi, cwd: projectDir, env });
		if (!rpc.ok) {
			blocked = true;
			blockedReason = `pi could not boot: ${rpc.reason}`;
		}
	} catch (err) {
		blocked = true;
		blockedReason = `setup failed: ${err?.message || err}`;
	}

	if (!blocked) {
		const serverJs = path.join(installedPkgDir, "dist", "mcp", "server.js");
		try {
			mcp = new McpSession(serverJs, projectDir, env);
			const init = await mcp.request(
				"initialize",
				{
					protocolVersion: "2024-11-05",
					capabilities: {},
					clientInfo: { name: "release-qa", version: "1" },
				},
				60_000,
			);
			if (init.error) throw new Error(init.error.message);
			mcp.notify("notifications/initialized", {});
			const listed = await mcp.request("tools/list", {}, 60_000);
			mcpTools = listed.error
				? { ok: false, reason: listed.error.message }
				: {
						ok: true,
						names: (listed.result?.tools ?? []).map((t) => t.name),
					};
			// One dispatch through the real per-edit path, so the diagnostics and
			// health rows below have a session to report on.
			await mcp.callToolText("pilens_analyze", { file: "a.ts" });
		} catch (err) {
			mcpTools = {
				ok: false,
				reason: `MCP session failed: ${err?.message || err}`,
			};
		}
	}

	const ctx = {
		env,
		gitRef: opts.gitRef,
		installedPkgDir,
		mcp,
		mcpTools,
		packListing,
		piBin: opts.pi,
		pollCapMs: opts.pollCapMs,
		projectDir,
		rpc,
		scratchRoot,
	};

	const results = [];
	for (const row of rows) {
		const probe = ROW_PROBES[row.id];
		let raw;
		let attempted = Boolean(probe);
		if (!probe) {
			raw = { status: "unimplemented" };
		} else if (blocked) {
			attempted = false;
			raw = { status: "blocked", detail: blockedReason };
		} else {
			log(`row ${row.id}`);
			try {
				raw = await probe(ctx);
			} catch (err) {
				raw = { status: "error", detail: `${err?.message || err}` };
			}
		}
		const classified = classifyProbe(raw);
		let witnessPath = "—";
		if (raw.witness) {
			const file = path.join(
				evidenceDir,
				`${row.id}.${raw.witness.ext ?? "txt"}`,
			);
			fs.writeFileSync(file, raw.witness.content ?? "");
			witnessPath = path.relative(opts.out, file).replaceAll("\\", "/");
		}
		results.push({
			id: row.id,
			outcome: classified.outcome,
			detail: classified.detail,
			implemented: attempted,
			witnessPath,
			shows: raw.shows ?? classified.detail,
		});
		log(`  → ${formatOutcome(classified)}`);
	}

	if (mcp) await mcp.close();

	const coverage = coverageArithmetic(results, rows.length);
	const verdict = shipVerdict(results, { blocked, blockedReason });
	const report = renderReport({
		rows,
		results,
		coverage,
		verdict,
		context: {
			"QA target": installSource,
			pi: describePi(opts.pi),
			baseline: path.relative(REPO_ROOT, opts.baseline).replaceAll("\\", "/"),
			"scratch root": scratchRoot,
			"polling cap": `${opts.pollCapMs}ms`,
			generated: new Date().toISOString(),
		},
	});
	const reportPath = path.join(opts.out, "release-qa-report.md");
	fs.writeFileSync(reportPath, report);

	console.log("");
	console.log(renderCoverageLine(coverage));
	console.log(`verdict: ${verdict.verdict} — ${verdict.reason}`);
	console.log(`report: ${reportPath}`);
	console.log(`evidence: ${evidenceDir}`);

	if (!opts.keep) {
		try {
			fs.rmSync(scratchRoot, {
				recursive: true,
				force: true,
				maxRetries: 5,
				retryDelay: 200,
			});
		} catch (err) {
			console.warn(`[release-qa] cleanup warning: ${err?.message || err}`);
		}
	}

	process.exit(coverage.balanced ? verdictExitCode(verdict.verdict) : 4);
}

/** Package-relative file list of an installed tree, in `npm pack --json` shape. */
function listInstalledFiles(root) {
	const out = [];
	const walk = (dir) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "node_modules") continue;
				walk(full);
			} else {
				out.push({ path: path.relative(root, full).replaceAll("\\", "/") });
			}
		}
	};
	walk(root);
	return out;
}

function describePi(piBin) {
	try {
		return `${piBin} ${execFileSync(piBin, ["--version"], { encoding: "utf8" }).trim()}`;
	} catch (err) {
		return `${piBin} (version unreadable: ${err?.message || err})`;
	}
}

const invokedDirectly =
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	main().catch((err) => {
		console.error("[release-qa] crashed:", err);
		process.exit(4);
	});
}
