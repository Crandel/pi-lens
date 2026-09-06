import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	pickNewestInRange,
	readPeerRange,
} from "../../scripts/lib/resolve-newest-in-range-host.mjs";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);
const CLI = path.join(REPO_ROOT, "scripts/resolve-newest-in-range-host.mjs");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

// Pure selection logic — no live registry, no fs, no child_process (#2613).
describe("pickNewestInRange (#2613)", () => {
	it("picks the highest version in an `||` range, ignoring the next minor", () => {
		// The exact range shape #2588 produced for pi-tui: two explicitly
		// endorsed minors, joined with `||` rather than a >=/< span.
		const versions = [
			"0.83.0",
			"0.84.0",
			"0.84.1",
			"0.84.9",
			"0.85.0",
			"0.85.1",
			"0.85.9",
			"0.86.0",
			"0.86.1",
		];
		expect(pickNewestInRange(versions, "^0.84.1 || ^0.85.0")).toBe("0.85.9");
	});

	it("excludes prereleases even when they are numerically newer", () => {
		const versions = ["0.85.9", "0.85.10-beta.0", "0.86.0"];
		expect(pickNewestInRange(versions, "^0.84.1 || ^0.85.0")).toBe("0.85.9");
	});

	it("returns null when nothing published satisfies the range", () => {
		const versions = ["0.80.10", "0.81.0"];
		expect(pickNewestInRange(versions, "^0.90.0")).toBeNull();
	});

	it("accepts a wildcard range (this repo's current pi-coding-agent peer spec)", () => {
		expect(pickNewestInRange(["0.84.1", "0.85.1"], "*")).toBe("0.85.1");
	});
});

describe("readPeerRange (#2613)", () => {
	it("reads the declared range for the named package", () => {
		const pkg = { peerDependencies: { demo: "^1.0.0" } };
		expect(readPeerRange(pkg, "demo")).toBe("^1.0.0");
	});

	it("throws when the package has no declared peer range", () => {
		expect(() => readPeerRange({ peerDependencies: {} }, "demo")).toThrow(
			/no peerDependencies/,
		);
	});
});

function fixtureRoot(peerRange: string) {
	const root = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-newest-in-range-"),
	);
	tempDirs.push(root);
	fs.writeFileSync(
		path.join(root, "package.json"),
		JSON.stringify({
			name: "fixture",
			peerDependencies: { "@earendil-works/pi-coding-agent": peerRange },
		}),
	);
	return root;
}

// A stub `npm` on PATH ahead of the real one, so the CLI's `npm view --json`
// call is hermetic (no live registry) while still exercising the real
// execFileSync spawn path end to end.
function stubNpm(root: string, versionsJson: string) {
	const binDir = path.join(root, "bin");
	fs.mkdirSync(binDir);
	const npmStub = path.join(binDir, "npm");
	fs.writeFileSync(
		npmStub,
		`#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(versionsJson)});\n`,
		{ mode: 0o755 },
	);
	return binDir;
}

function runCli(root: string, binDir: string, args: string[]) {
	return execFileSync(process.execPath, [CLI, ...args], {
		cwd: root,
		env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
		encoding: "utf-8",
	});
}

describe("resolve-newest-in-range-host.mjs CLI (#2613)", () => {
	it("prints the resolved version and writes GITHUB_OUTPUT", () => {
		const root = fixtureRoot("^0.84.1 || ^0.85.0");
		const binDir = stubNpm(
			root,
			JSON.stringify(["0.84.1", "0.85.0", "0.85.9", "0.86.0"]),
		);
		const outputFile = path.join(root, "gh-output");
		fs.writeFileSync(outputFile, "");
		const stdout = execFileSync(process.execPath, [CLI, "@earendil-works/pi-coding-agent"], {
			cwd: root,
			env: {
				...process.env,
				PATH: `${binDir}:${process.env.PATH}`,
				GITHUB_OUTPUT: outputFile,
			},
			encoding: "utf-8",
		});
		expect(stdout.trim()).toBe("0.85.9");
		expect(fs.readFileSync(outputFile, "utf-8")).toBe("version=0.85.9\n");
	});

	it("exits 4 with a message when the range matches no published version", () => {
		const root = fixtureRoot("^0.90.0");
		const binDir = stubNpm(root, JSON.stringify(["0.84.1", "0.85.1"]));
		expect(() => runCli(root, binDir, ["@earendil-works/pi-coding-agent"])).toThrow(
			expect.objectContaining({ status: 4 }),
		);
		try {
			runCli(root, binDir, ["@earendil-works/pi-coding-agent"]);
			expect.unreachable("expected the CLI to exit nonzero");
		} catch (err) {
			const e = err as { status?: number; stderr?: string };
			expect(e.status).toBe(4);
			expect(e.stderr).toMatch(/no published, non-prerelease version/);
		}
	});

	it("exits 2 when the package has no declared peerDependencies range", () => {
		const root = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-newest-in-range-norange-"),
		);
		tempDirs.push(root);
		fs.writeFileSync(
			path.join(root, "package.json"),
			JSON.stringify({ name: "fixture", peerDependencies: {} }),
		);
		const binDir = stubNpm(root, JSON.stringify(["0.85.1"]));
		try {
			runCli(root, binDir, ["@earendil-works/pi-coding-agent"]);
			expect.unreachable("expected the CLI to exit nonzero");
		} catch (err) {
			const e = err as { status?: number; stderr?: string };
			expect(e.status).toBe(2);
			expect(e.stderr).toMatch(/no peerDependencies/);
		}
	});
});
