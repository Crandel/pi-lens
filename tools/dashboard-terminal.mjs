#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const logPath = process.argv[2];
if (!logPath) {
	console.error("Usage: dashboard-terminal.mjs <dashboard-events.jsonl>");
	process.exit(1);
}

const state = {
	startedAt: Date.now(),
	turnIndex: undefined,
	activeTools: new Map(),
	configs: new Map(),
	configsSeen: 0,
	formatters: new Map(),
	runners: new Map(),
	lsps: new Map(),
	files: new Map(),
	eventCount: 0,
	lastEventAt: undefined,
	sessionSummary: null,
};

let offset = 0;
let renderTimer;

function rel(filePath) {
	const root = [...state.configs.values()][0]?.projectRoot || process.cwd();
	try {
		const r = path.relative(root, filePath).replace(/\\/g, "/");
		return r && !r.startsWith("..") ? r : filePath.replace(/\\/g, "/");
	} catch {
		return String(filePath || "").replace(/\\/g, "/");
	}
}

function link(filePath, label, line, column) {
	if (!filePath) return label;
	let uri;
	try {
		uri = pathToFileURL(filePath).href;
		if (line) uri += `#L${line}${column ? `:${column}` : ""}`;
	} catch {
		return label;
	}
	return `\x1b]8;;${uri}\x1b\\${label}\x1b]8;;\x1b\\`;
}

function color(n, s) {
	return `\x1b[${n}m${s}\x1b[0m`;
}
const dim = (s) => color(90, s);
const red = (s) => color(31, s);
const yellow = (s) => color(33, s);
const green = (s) => color(32, s);
const cyan = (s) => color(36, s);
const bold = (s) => color(1, s);
const blue = (s) => color(34, s);

function fileState(filePath) {
	const key = filePath || "<unknown>";
	let entry = state.files.get(key);
	if (!entry) {
		entry = { filePath: key, diagnostics: new Map(), touched: 0, lastAt: 0 };
		state.files.set(key, entry);
	}
	entry.touched++;
	entry.lastAt = Date.now();
	return entry;
}

function applyEvent(event) {
	state.eventCount++;
	state.lastEventAt = event.ts;
	if (event.projectRoot) {
		state.configs.set("__root", { projectRoot: event.projectRoot });
	}

	switch (event.type) {
		case "pi.turn.start":
			state.turnIndex = event.turnIndex;
			break;
		case "pi.tool.start":
			state.activeTools.set(
				event.toolCallId || `${event.toolName}:${state.eventCount}`,
				{
					name: event.toolName,
					args: event.argsPreview,
					startedAt: Date.now(),
				},
			);
			break;
		case "pi.tool.end":
			state.activeTools.delete(event.toolCallId);
			break;
		case "lens.config.formatter_selected":
			state.configsSeen++;
			state.configs.set(`${event.cwd}:${event.filePath}`, event);
			fileState(event.filePath);
			break;
		case "lens.formatter.run": {
			const key = event.formatter || "unknown";
			const cur = state.formatters.get(key) || {
				name: key,
				runs: 0,
				changed: 0,
				failed: 0,
				files: new Set(),
			};
			cur.runs++;
			if (event.changed) cur.changed++;
			if (!event.success) cur.failed++;
			cur.files.add(event.filePath);
			state.formatters.set(key, cur);
			fileState(event.filePath);
			break;
		}
		case "lens.runner.run": {
			const key = event.runnerId || "unknown";
			const cur = state.runners.get(key) || {
				id: key,
				runs: 0,
				diagnostics: 0,
				failed: 0,
				durationMs: 0,
				files: new Set(),
				status: "",
			};
			cur.runs++;
			cur.diagnostics += Number(event.diagnosticCount || 0);
			cur.durationMs += Number(event.durationMs || 0);
			cur.status = event.status;
			if (event.status === "failed") cur.failed++;
			cur.files.add(event.filePath);
			state.runners.set(key, cur);
			fileState(event.filePath);
			break;
		}
		case "lens.lsp": {
			const key = `${event.serverId}@${event.root}`;
			const cur = state.lsps.get(key) || {
				serverId: event.serverId,
				root: event.root,
				starts: 0,
				status: "",
				failures: 0,
				source: "",
			};
			if (event.status === "spawn_start") cur.starts++;
			if (event.status === "spawn_failed") cur.failures++;
			cur.status = event.status;
			cur.source = event.source || cur.source;
			state.lsps.set(key, cur);
			if (event.filePath) fileState(event.filePath);
			break;
		}
		case "lens.session.summary":
			state.sessionSummary = event;
			state.configs.set("__root", { projectRoot: event.projectRoot });
			break;
		case "lens.diagnostics": {
			const f = fileState(event.filePath);
			f.diagnostics.clear();
			for (const d of event.diagnostics || []) {
				const key = `${d.tool || ""}:${d.rule || ""}:${d.line || 0}:${d.message || ""}`;
				f.diagnostics.set(key, d);
			}
			break;
		}
	}
	scheduleRender();
}

function scheduleRender() {
	clearTimeout(renderTimer);
	renderTimer = setTimeout(render, 80);
}

function render() {
	const rows = [];
	const folder = state.configs.get("__root")?.projectRoot || "?";
	rows.push(`${cyan("pi-lens dashboard")} ${dim(folder)}`);
	rows.push(dim(`log: ${logPath}`));
	rows.push("");

	// --- Static configs identified in the folder ---
	if (state.configsSeen > 0) {
		const configs = [...state.configs.values()]
			.filter((c) => c.type === "lens.config.formatter_selected")
			.slice(-12);

		// Derive languages from config file extensions
		const extLang = {
			ts: "TS",
			tsx: "TSX",
			js: "JS",
			jsx: "JSX",
			css: "CSS",
			json: "JSON",
			yaml: "YAML",
			yml: "YAML",
			md: "MD",
			py: "Python",
			rs: "Rust",
			go: "Go",
			java: "Java",
			c: "C",
			cpp: "C++",
			h: "C",
			hpp: "C++",
			sh: "Shell",
			bash: "Shell",
			toml: "TOML",
			xml: "XML",
			sql: "SQL",
			graphql: "GraphQL",
			vue: "Vue",
			svelte: "Svelte",
		};
		const seen = new Set();
		for (const c of configs) {
			const ext = String(c.filePath || "")
				.split(".")
				.pop()
				?.toLowerCase();
			const lang = extLang[ext];
			if (lang) seen.add(lang);
		}
		const langs = [...seen].sort((a, b) => a.localeCompare(b));

		const hasExplicit = configs.some(
			(c) => c.reason === "explicit-config" || c.reason === "detect",
		);
		rows.push(
			`${cyan("Configs identified")}${langs.length ? dim(` (${langs.join(", ")})`) : ""}`,
		);
		if (hasExplicit) {
			for (const c of configs.filter(
				(c) => c.reason === "explicit-config" || c.reason === "detect",
			)) {
				rows.push(
					`  ${link(c.filePath, rel(c.filePath))} → ${c.formatter || "none"} ${dim(c.reason || "")}`,
				);
			}
		} else {
			rows.push(dim("  smart defaults enabled"));
		}
		rows.push("");
	}

	// --- Session start summary (sticky, shown once received) ---
	if (state.sessionSummary) {
		const s = state.sessionSummary;
		rows.push(bold("Session Summary"));

		// Languages
		if (s.languages && s.languages.length > 0) {
			const langParts = s.languages.map((l) => {
				const cfg = l.configured ? green("✓") : yellow("?");
				return `${cfg}${l.kind}(${l.count})`;
			});
			rows.push(`  Languages: ${langParts.join("  ")}`);
		}

		// Tools (preinstall / LSP)
		const toolLines = [];
		if (s.lspEnabled) toolLines.push(green("LSP"));
		if (s.startupTools && s.startupTools.length > 0) {
			for (const t of s.startupTools) {
				toolLines.push(t.autoInstall ? green(t.name) : dim(t.name));
			}
		}
		if (s.testRunner) toolLines.push(blue(`test:${s.testRunner}`));
		if (s.goAvailable) toolLines.push(blue("go"));
		if (s.rustAvailable) toolLines.push(blue("rust"));
		if (s.prettierDetected) toolLines.push(dim("prettier"));
		toolLines.push(
			s.lspWarmFiles > 0 ? green(`${s.lspWarmFiles} warm`) : dim("0 warm"),
		);
		rows.push(`  Tools: ${toolLines.join("  ")}`);

		// Startup scans
		if (s.startupScans && s.startupScans.length > 0) {
			rows.push(`  Scans: ${s.startupScans.map((n) => dim(n)).join(", ")}`);
		}

		// Mode / root
		const metaParts = [];
		metaParts.push(dim(`mode:${s.startupMode || "?"}`));
		if (s.sourceFileCount != null)
			metaParts.push(dim(`${s.sourceFileCount} src`));
		if (s.monorepoOverride) metaParts.push(yellow("monorepo"));
		if (s.staleTSCleaned > 0)
			metaParts.push(yellow(`${s.staleTSCleaned} stale ts`));
		rows.push(`  ${metaParts.join("  ")}`);

		rows.push("");
	}

	rows.push(cyan("Formatters"));
	if (state.formatters.size === 0) rows.push(dim("  none yet"));
	for (const f of [...state.formatters.values()]
		.sort((a, b) => b.runs - a.runs)
		.slice(0, 12)) {
		rows.push(
			`  ${f.failed ? red(f.name) : green(f.name)} runs=${f.runs} changed=${f.changed} files=${f.files.size}`,
		);
	}
	rows.push("");

	rows.push(cyan("Linters / runners"));
	if (state.runners.size === 0) rows.push(dim("  none yet"));
	for (const r of [...state.runners.values()]
		.sort((a, b) => b.runs - a.runs)
		.slice(0, 18)) {
		const name = r.failed
			? red(r.id)
			: r.diagnostics
				? yellow(r.id)
				: green(r.id);
		rows.push(
			`  ${name} runs=${r.runs} diags=${r.diagnostics} files=${r.files.size} total=${r.durationMs}ms`,
		);
	}
	rows.push("");

	rows.push(cyan("LSPs"));
	if (state.lsps.size === 0) rows.push(dim("  none yet"));
	for (const l of [...state.lsps.values()].slice(-12)) {
		const status =
			l.status === "spawn_success"
				? green(l.status)
				: l.failures
					? red(l.status)
					: yellow(l.status);
		rows.push(
			`  ${l.serverId} ${status} starts=${l.starts} ${dim(rel(l.root))}`,
		);
	}
	rows.push("");

	rows.push(cyan("Touched files + diagnostics"));
	const files = [...state.files.values()]
		.sort((a, b) => b.lastAt - a.lastAt)
		.slice(0, 16);
	if (files.length === 0) rows.push(dim("  none yet"));
	for (const f of files) {
		const ds = [...f.diagnostics.values()];
		const marker = ds.some(
			(d) => d.semantic === "blocking" || d.severity === "error",
		)
			? red("●")
			: ds.length
				? yellow("▲")
				: green("✓");
		rows.push(
			`  ${marker} ${link(f.filePath, rel(f.filePath))} ${dim(`${ds.length} diagnostics`)}`,
		);
		for (const d of ds.slice(0, 3)) {
			const loc = d.line ? `:${d.line}${d.column ? `:${d.column}` : ""}` : "";
			rows.push(
				`     ${dim(d.tool || "")} ${link(f.filePath, `${d.rule || "diagnostic"}${loc}`, d.line, d.column)} ${String(d.message || "").slice(0, 90)}`,
			);
		}
		if (ds.length > 3) rows.push(dim(`     +${ds.length - 3} more`));
	}

	const output = rows.join("\n");
	process.stdout.write("\x1b[H" + output + "\n");
	// Clear any leftover lines below the rendered content
	process.stdout.write("\x1b[0J");
	// Scroll viewport to the bottom so the latest content is visible
	process.stdout.write("\x1b[999;1H");
}

function readNew() {
	fs.stat(logPath, (err, st) => {
		if (err) return scheduleRender();
		if (st.size < offset) offset = 0;
		if (st.size === offset) return;
		const stream = fs.createReadStream(logPath, {
			start: offset,
			end: st.size - 1,
			encoding: "utf8",
		});
		offset = st.size;
		let buf = "";
		stream.on("data", (chunk) => (buf += chunk));
		stream.on("end", () => {
			for (const line of buf.split(/\r?\n/)) {
				if (!line.trim()) continue;
				try {
					applyEvent(JSON.parse(line));
				} catch {}
			}
		});
	});
}

process.title = "pi-lens dashboard";
render();
readNew();
try {
	const watcher = fs.watch(
		path.dirname(logPath),
		{ persistent: true },
		(_event, name) => {
			if (
				!name ||
				path.resolve(path.dirname(logPath), name.toString()) ===
					path.resolve(logPath)
			)
				readNew();
		},
	);
	watcher.on("error", () => {
		// Polling fallback below keeps the dashboard alive on filesystems that
		// reject fs.watch (some Windows temp/network directories).
	});
} catch {
	// Polling fallback below.
}
setInterval(readNew, 1000).unref?.();
