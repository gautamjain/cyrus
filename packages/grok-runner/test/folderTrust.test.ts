import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	collectFolderTrustPaths,
	ensureGrokFolderTrust,
	isPathTrusted,
	parseTrustedFoldersToml,
} from "../src/backend/folderTrust.js";

describe("parseTrustedFoldersToml / isPathTrusted", () => {
	it("parses Grok trusted_folders.toml shape", () => {
		const folders = parseTrustedFoldersToml(`
[folders."/home/gj/bartbuddy"]
trusted = true
decided_at = 1785386454

[folders."/tmp/other"]
trusted = false
`);
		expect(folders.get("/home/gj/bartbuddy")).toEqual({
			trusted: true,
			decided_at: 1785386454,
		});
		expect(folders.get("/tmp/other")?.trusted).toBe(false);
	});

	it("cascade: trusted parent trusts descendants; nearer untrust wins", () => {
		const folders = new Map([
			["/work/repos", { trusted: true }],
			["/work/repos/evil", { trusted: false }],
		]);
		expect(isPathTrusted(folders, "/work/repos/good/src", "/home/user")).toBe(
			true,
		);
		expect(isPathTrusted(folders, "/work/repos/evil/src", "/home/user")).toBe(
			false,
		);
		expect(isPathTrusted(folders, "/elsewhere", "/home/user")).toBe(false);
	});
});

describe("collectFolderTrustPaths", () => {
	it("includes workspace for a plain directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "grok-trust-plain-"));
		const paths = collectFolderTrustPaths(dir);
		expect(paths).toContain(resolve(dir));
		expect(paths).toHaveLength(1);
	});

	it("includes main repo workdir for a linked git worktree layout", () => {
		// Simulate Cyrus: main repo + worktree with .git file pointing at worktrees/
		const root = mkdtempSync(join(tmpdir(), "grok-trust-wt-"));
		const main = join(root, "repos", "app");
		const worktree = join(root, "worktrees", "ISSUE-1");
		mkdirSync(join(main, ".git", "worktrees", "ISSUE-1"), { recursive: true });
		mkdirSync(worktree, { recursive: true });
		writeFileSync(
			join(worktree, ".git"),
			`gitdir: ${join(main, ".git", "worktrees", "ISSUE-1")}\n`,
		);

		const paths = collectFolderTrustPaths(worktree).map((p) => resolve(p));
		expect(paths).toContain(resolve(worktree));
		expect(paths).toContain(resolve(main));
	});
});

describe("ensureGrokFolderTrust", () => {
	it("writes trusted=true for workspace paths into a custom store", () => {
		const dir = mkdtempSync(join(tmpdir(), "grok-trust-ensure-"));
		const storePath = join(dir, "trusted_folders.toml");
		const workspace = join(dir, "session-wd");
		mkdirSync(workspace);

		const result = ensureGrokFolderTrust(workspace, {
			storePath,
			decidedAt: 1_700_000_000,
		});

		expect(result.writtenPaths).toContain(resolve(workspace));
		expect(result.trustedPaths).toContain(resolve(workspace));

		const body = readFileSync(storePath, "utf8");
		expect(body).toContain(`[folders."${resolve(workspace)}"]`);
		expect(body).toContain("trusted = true");
		expect(body).toContain("decided_at = 1700000000");

		// Idempotent second call
		const again = ensureGrokFolderTrust(workspace, { storePath });
		expect(again.writtenPaths).toEqual([]);
		expect(again.trustedPaths).toContain(resolve(workspace));
	});

	it("merges with existing store entries without clobbering", () => {
		const dir = mkdtempSync(join(tmpdir(), "grok-trust-merge-"));
		const storePath = join(dir, "trusted_folders.toml");
		const existing = resolve(join(dir, "already"));
		writeFileSync(
			storePath,
			`[folders."${existing}"]\ntrusted = true\ndecided_at = 1\n`,
		);

		const workspace = join(dir, "new-wd");
		mkdirSync(workspace);
		ensureGrokFolderTrust(workspace, { storePath, decidedAt: 2 });

		const folders = parseTrustedFoldersToml(readFileSync(storePath, "utf8"));
		expect(folders.get(existing)?.trusted).toBe(true);
		expect(folders.get(resolve(workspace))?.trusted).toBe(true);
	});

	it("flips explicit untrusted to trusted for Cyrus workspaces", () => {
		const dir = mkdtempSync(join(tmpdir(), "grok-trust-flip-"));
		const storePath = join(dir, "trusted_folders.toml");
		const workspace = join(dir, "wd");
		mkdirSync(workspace);
		writeFileSync(
			storePath,
			`[folders."${resolve(workspace)}"]\ntrusted = false\ndecided_at = 1\n`,
		);

		const result = ensureGrokFolderTrust(workspace, {
			storePath,
			decidedAt: 9,
		});
		expect(result.writtenPaths).toContain(resolve(workspace));
		const folders = parseTrustedFoldersToml(readFileSync(storePath, "utf8"));
		expect(folders.get(resolve(workspace))).toEqual({
			trusted: true,
			decided_at: 9,
		});
	});
});
