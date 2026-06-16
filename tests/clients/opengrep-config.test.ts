import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createStarterOpengrepConfig,
	findLocalOpengrepConfig,
	normalizeOpengrepConfigArg,
	resolveOpengrepConfig,
	savePiLensOpengrepConfig,
} from "../../clients/opengrep-config.js";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "opengrep-cfg-"));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("opengrep config resolution", () => {
	it("is disabled with a reason when no config exists and not enabled", () => {
		const r = resolveOpengrepConfig(tmp);
		expect(r.enabled).toBe(false);
		expect(r.source).toBe("disabled");
		expect(r.reason).toMatch(/not explicitly enabled/);
	});

	it("auto-enables from a local .opengrep.yml", () => {
		const cfg = path.join(tmp, ".opengrep.yml");
		fs.writeFileSync(cfg, "rules: []\n");
		const r = resolveOpengrepConfig(tmp);
		expect(r.enabled).toBe(true);
		expect(r.source).toBe("local");
		expect(r.configArg).toBe(cfg);
	});

	it("also detects a legacy .semgrep.yml (shared rule format)", () => {
		// Opengrep natively consumes semgrep-format rules; existing repos carry .semgrep.yml.
		const cfg = path.join(tmp, ".semgrep.yml");
		fs.writeFileSync(cfg, "rules: []\n");
		expect(findLocalOpengrepConfig(tmp)).toBe(cfg);
		expect(resolveOpengrepConfig(tmp).enabled).toBe(true);
	});

	it("flag-enabled without any config is disabled with actionable guidance", () => {
		const r = resolveOpengrepConfig(tmp, { enabled: true });
		expect(r.enabled).toBe(false);
		expect(r.reason).toMatch(/--lens-opengrep-config/);
	});

	it("flag-enabled with --config auto is enabled from the flag", () => {
		const r = resolveOpengrepConfig(tmp, { enabled: true, config: "auto" });
		expect(r.enabled).toBe(true);
		expect(r.source).toBe("flag");
		expect(r.configArg).toBe("auto");
	});

	it("honors a persisted .pi-lens/opengrep.json (enabled + config)", () => {
		savePiLensOpengrepConfig(tmp, { enabled: true, config: "p/ci" });
		const r = resolveOpengrepConfig(tmp);
		expect(r.enabled).toBe(true);
		expect(r.source).toBe("pi-lens");
		expect(r.configArg).toBe("p/ci");
	});

	it("a persisted disabled flag wins over local discovery", () => {
		fs.writeFileSync(path.join(tmp, ".opengrep.yml"), "rules: []\n");
		savePiLensOpengrepConfig(tmp, { enabled: false });
		const r = resolveOpengrepConfig(tmp);
		expect(r.enabled).toBe(false);
		expect(r.reason).toMatch(/opengrep\.json/);
	});
});

describe("normalizeOpengrepConfigArg", () => {
	it("passes registry/auto configs through verbatim", () => {
		expect(normalizeOpengrepConfigArg("auto", tmp)).toBe("auto");
		expect(normalizeOpengrepConfigArg("p/security", tmp)).toBe("p/security");
		expect(normalizeOpengrepConfigArg("r/some.rule", tmp)).toBe("r/some.rule");
	});

	it("resolves relative paths against cwd and keeps absolute paths", () => {
		expect(normalizeOpengrepConfigArg("rules/x.yml", tmp)).toBe(
			path.resolve(tmp, "rules/x.yml"),
		);
		const abs = path.join(tmp, "abs.yml");
		expect(normalizeOpengrepConfigArg(abs, tmp)).toBe(abs);
	});

	it("returns undefined for empty/missing input", () => {
		expect(normalizeOpengrepConfigArg(undefined, tmp)).toBeUndefined();
		expect(normalizeOpengrepConfigArg("   ", tmp)).toBeUndefined();
	});
});

describe("createStarterOpengrepConfig", () => {
	it("writes a starter .opengrep.yml", () => {
		const p = createStarterOpengrepConfig(tmp);
		expect(p).toBe(path.join(tmp, ".opengrep.yml"));
		expect(fs.readFileSync(p, "utf-8")).toMatch(/pi-lens\.no-eval/);
	});
});
