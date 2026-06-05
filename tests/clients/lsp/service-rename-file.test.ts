import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { LSPService } from "../../../clients/lsp/index.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";

type MockRenameClient = {
	root: string;
	isAlive: ReturnType<typeof vi.fn>;
	willRenameFiles: ReturnType<typeof vi.fn>;
	didRenameFiles: ReturnType<typeof vi.fn>;
};

function makeClient(root: string, edit: unknown): MockRenameClient {
	return {
		root,
		isAlive: vi.fn(() => true),
		willRenameFiles: vi.fn(async () => edit),
		didRenameFiles: vi.fn(async () => undefined),
	};
}

describe("LSPService.renameFile", () => {
	it("merges willRenameFiles edits by client priority, renames, and notifies all active clients", async () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-lsp-rename-file-"));
		const oldPath = path.join(tmpDir, "old.ts");
		const newPath = path.join(tmpDir, "new.ts");
		const importPath = path.join(tmpDir, "import.ts");
		fs.writeFileSync(oldPath, "export const value = 1;\n", "utf-8");
		fs.writeFileSync(importPath, "import { value } from './old';\n", "utf-8");
		const importUri = pathToFileURL(importPath).href;

		const primary = makeClient(tmpDir, {
			changes: {
				[importUri]: [
					{
						range: {
							start: { line: 0, character: 25 },
							end: { line: 0, character: 28 },
						},
						newText: "new",
					},
				],
			},
		});
		const secondary = makeClient(tmpDir, {
			changes: {
				[importUri]: [
					{
						range: {
							start: { line: 0, character: 23 },
							end: { line: 0, character: 28 },
						},
						newText: "./new",
					},
				],
			},
		});

		const service = new LSPService();
		const state = (service as unknown as { state: { clients: Map<string, unknown> } }).state;
		state.clients.set(`typescript:${normalizeMapKey(tmpDir)}`, primary);
		state.clients.set(`eslint:${normalizeMapKey(tmpDir)}`, secondary);

		try {
			const result = await service.renameFile(oldPath, newPath, {
				cwd: tmpDir,
				apply: true,
			});

			expect(result.applied).toBe(true);
			expect(result.droppedConflicts).toBe(1);
			expect(fs.existsSync(oldPath)).toBe(false);
			expect(fs.readFileSync(newPath, "utf-8")).toBe("export const value = 1;\n");
			expect(fs.readFileSync(importPath, "utf-8")).toBe("import { value } from './new';\n");
			expect(primary.willRenameFiles).toHaveBeenCalledWith(oldPath, newPath);
			expect(secondary.willRenameFiles).toHaveBeenCalledWith(oldPath, newPath);
			expect(primary.didRenameFiles).toHaveBeenCalledWith(oldPath, newPath);
			expect(secondary.didRenameFiles).toHaveBeenCalledWith(oldPath, newPath);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});
