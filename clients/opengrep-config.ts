import * as fs from "node:fs";
import * as path from "node:path";
import { getProjectDataDir } from "./file-utils.js";
import { walkUpDirs } from "./path-utils.js";

export interface PiLensOpengrepConfig {
	enabled?: boolean;
	/** Opengrep config: local path, auto, p/<pack>, r/<rule>, or omitted for local auto-discovery. */
	config?: string;
}

export interface ResolvedOpengrepConfig {
	enabled: boolean;
	/** Value to pass after --config. */
	configArg?: string;
	source: "local" | "pi-lens" | "flag" | "disabled";
	reason?: string;
}

// Opengrep is a fork of Semgrep and natively consumes the same rule format, so
// we discover both `.opengrep.*` (preferred) and the de-facto `.semgrep.*` rule
// files an existing repo may already carry. These are third-party rule files,
// not pi-lens's own configuration surface (which is opengrep-only).
export const LOCAL_OPENGREP_CONFIG_NAMES = [
	".opengrep.yml",
	".opengrep.yaml",
	"opengrep.yml",
	"opengrep.yaml",
	".semgrep.yml",
	".semgrep.yaml",
	"semgrep.yml",
	"semgrep.yaml",
] as const;

export function findLocalOpengrepConfig(startDir: string): string | undefined {
	for (const dir of walkUpDirs(startDir || process.cwd())) {
		for (const name of LOCAL_OPENGREP_CONFIG_NAMES) {
			const candidate = path.join(dir, name);
			if (fs.existsSync(candidate)) return candidate;
		}
	}
	return undefined;
}

export function findPiLensOpengrepConfigPath(
	startDir: string,
): string | undefined {
	// Check the configured data dir for the project first (respects PILENS_DATA_DIR)
	const dataCandidate = path.join(getProjectDataDir(startDir), "opengrep.json");
	if (fs.existsSync(dataCandidate)) return dataCandidate;
	// Fall back to legacy walk-up search for backwards compatibility
	for (const dir of walkUpDirs(startDir || process.cwd())) {
		const candidate = path.join(dir, ".pi-lens", "opengrep.json");
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}

export function getPiLensOpengrepConfigPath(cwd: string): string {
	return path.join(
		getProjectDataDir(path.resolve(cwd || process.cwd())),
		"opengrep.json",
	);
}

export function loadPiLensOpengrepConfig(
	startDir: string,
): PiLensOpengrepConfig | undefined {
	const configPath = findPiLensOpengrepConfigPath(startDir);
	if (!configPath) return undefined;
	try {
		const parsed = JSON.parse(fs.readFileSync(configPath, "utf-8")) as unknown;
		if (!parsed || typeof parsed !== "object") return undefined;
		const raw = parsed as Record<string, unknown>;
		return {
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
			config: typeof raw.config === "string" ? raw.config : undefined,
		};
	} catch {
		return undefined;
	}
}

export function savePiLensOpengrepConfig(
	cwd: string,
	config: PiLensOpengrepConfig,
): string {
	const configPath = getPiLensOpengrepConfigPath(cwd);
	fs.mkdirSync(path.dirname(configPath), { recursive: true });
	fs.writeFileSync(
		`${configPath}.tmp`,
		`${JSON.stringify(config, null, "\t")}\n`,
	);
	fs.renameSync(`${configPath}.tmp`, configPath);
	return configPath;
}

export function removePiLensOpengrepConfig(cwd: string): boolean {
	const configPath = getPiLensOpengrepConfigPath(cwd);
	if (!fs.existsSync(configPath)) return false;
	fs.unlinkSync(configPath);
	return true;
}

function isRegistryOrAutoConfig(config: string): boolean {
	return (
		config === "auto" || config.startsWith("p/") || config.startsWith("r/")
	);
}

export function normalizeOpengrepConfigArg(
	config: string | undefined,
	cwd: string,
): string | undefined {
	if (!config) return undefined;
	const trimmed = config.trim();
	if (!trimmed) return undefined;
	if (isRegistryOrAutoConfig(trimmed)) return trimmed;
	return path.isAbsolute(trimmed) ? trimmed : path.resolve(cwd, trimmed);
}

export function resolveOpengrepConfig(
	cwd: string,
	flags?: { enabled?: boolean; config?: string | boolean | undefined },
): ResolvedOpengrepConfig {
	const localConfig = findLocalOpengrepConfig(cwd);
	const persisted = loadPiLensOpengrepConfig(cwd);
	const flagConfig =
		typeof flags?.config === "string" && flags.config.trim()
			? flags.config.trim()
			: undefined;

	if (persisted?.enabled === false && !flags?.enabled) {
		return {
			enabled: false,
			source: "disabled",
			reason: "disabled in .pi-lens/opengrep.json",
		};
	}

	if (flags?.enabled) {
		const configArg = normalizeOpengrepConfigArg(flagConfig ?? localConfig, cwd);
		if (!configArg) {
			return {
				enabled: false,
				source: "disabled",
				reason:
					"--lens-opengrep was set but no Opengrep config was found; pass --lens-opengrep-config auto|p/<pack>|<path> or create .opengrep.yml",
			};
		}
		return {
			enabled: true,
			configArg,
			source: "flag",
		};
	}

	if (persisted?.enabled) {
		const configArg = normalizeOpengrepConfigArg(
			persisted.config ?? localConfig,
			cwd,
		);
		if (!configArg) {
			return {
				enabled: false,
				source: "disabled",
				reason:
					"Opengrep is enabled in .pi-lens/opengrep.json but no config is set or discovered",
			};
		}
		return {
			enabled: true,
			configArg,
			source: "pi-lens",
		};
	}

	if (localConfig) {
		return {
			enabled: true,
			configArg: localConfig,
			source: "local",
		};
	}

	return {
		enabled: false,
		source: "disabled",
		reason: "no local opengrep config and opengrep not explicitly enabled",
	};
}

export function createStarterOpengrepConfig(cwd: string): string {
	const configPath = path.join(
		path.resolve(cwd || process.cwd()),
		".opengrep.yml",
	);
	if (fs.existsSync(configPath)) return configPath;
	const contents = `rules:
  - id: pi-lens.no-eval
    pattern: eval(...)
    message: Avoid eval; use a safer, explicit parser or allowlisted operation.
    languages: [javascript, typescript]
    severity: ERROR
    metadata:
      pi-lens:
        semantic: blocking
        defect_class: injection
        confidence: high
        fix: Replace eval with a constrained parser or an explicit allowlist.
`;
	fs.writeFileSync(configPath, contents);
	return configPath;
}
