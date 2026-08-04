import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrokSkillStager } from "../src/GrokSkillStager.js";

function writeSkill(root: string, name: string): string {
	const skillDir = join(root, name);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${name} description\n---\n\nbody\n`,
	);
	return skillDir;
}

describe("GrokSkillStager", () => {
	let tempDirs: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of tempDirs) {
			rmSync(dir, { recursive: true, force: true });
		}
		tempDirs = [];
	});

	function makeTempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "grok-skills-test-"));
		tempDirs.push(dir);
		return dir;
	}

	it("stages allowed managed and repo-local skills; user plugin wins over internal", () => {
		const root = makeTempDir();
		const worktree = join(root, "worktree");
		const userPlugin = join(root, "user-plugin");
		const internalPlugin = join(root, "internal-plugin");
		mkdirSync(worktree, { recursive: true });
		writeSkill(join(userPlugin, "skills"), "verify-and-ship");
		// Same name in internal — must be ignored (user first)
		writeSkill(join(internalPlugin, "skills"), "verify-and-ship");
		writeSkill(join(internalPlugin, "skills"), "implementation");
		writeSkill(join(worktree, ".claude", "skills"), "deep-review");

		const stager = new GrokSkillStager({
			workingDirectory: worktree,
			plugins: [
				{ type: "local", path: userPlugin },
				{ type: "local", path: internalPlugin },
			],
			skills: ["verify-and-ship", "deep-review", "implementation"],
		});
		stager.stage();

		const stagedUser = join(worktree, ".agents", "skills", "verify-and-ship");
		const stagedImpl = join(worktree, ".agents", "skills", "implementation");
		const stagedRepo = join(worktree, ".agents", "skills", "deep-review");

		expect(lstatSync(stagedUser).isSymbolicLink()).toBe(true);
		// Symlink points at user plugin, not internal
		expect(readFileSync(join(stagedUser, "SKILL.md"), "utf-8")).toContain(
			"name: verify-and-ship",
		);
		expect(lstatSync(stagedImpl).isSymbolicLink()).toBe(true);
		expect(lstatSync(stagedRepo).isSymbolicLink()).toBe(true);
		expect(stager.getStagedSkillNames().sort()).toEqual([
			"deep-review",
			"implementation",
			"verify-and-ship",
		]);

		stager.cleanup();
		expect(existsSync(stagedUser)).toBe(false);
		expect(existsSync(stagedImpl)).toBe(false);
		expect(existsSync(stagedRepo)).toBe(false);
		expect(stager.getStagedSkillNames()).toEqual([]);
	});

	it("does not stage skills outside the allow-list", () => {
		const root = makeTempDir();
		const worktree = join(root, "worktree");
		const userPlugin = join(root, "user-plugin");
		mkdirSync(worktree, { recursive: true });
		writeSkill(join(userPlugin, "skills"), "custom-user");
		writeSkill(join(userPlugin, "skills"), "other");

		const stager = new GrokSkillStager({
			workingDirectory: worktree,
			plugins: [{ type: "local", path: userPlugin }],
			skills: ["custom-user"],
		});
		stager.stage();

		expect(existsSync(join(worktree, ".agents", "skills", "custom-user"))).toBe(
			true,
		);
		expect(existsSync(join(worktree, ".agents", "skills", "other"))).toBe(
			false,
		);
		stager.cleanup();
	});

	it("does not overwrite an existing skill with the same name", () => {
		const root = makeTempDir();
		const worktree = join(root, "worktree");
		const userPlugin = join(root, "user-plugin");
		mkdirSync(join(worktree, ".agents", "skills", "custom-user"), {
			recursive: true,
		});
		writeSkill(join(userPlugin, "skills"), "custom-user");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		new GrokSkillStager({
			workingDirectory: worktree,
			plugins: [{ type: "local", path: userPlugin }],
			skills: ["custom-user"],
		}).stage();

		const existingSkill = join(worktree, ".agents", "skills", "custom-user");
		expect(lstatSync(existingSkill).isDirectory()).toBe(true);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("Skipping managed skill 'custom-user'"),
		);
	});

	it("adds the staged .agents directory to local git exclude", () => {
		const root = makeTempDir();
		const worktree = join(root, "worktree");
		const userPlugin = join(root, "user-plugin");
		mkdirSync(worktree, { recursive: true });
		execFileSync("git", ["init"], { cwd: worktree, stdio: "ignore" });
		writeSkill(join(userPlugin, "skills"), "custom-user");

		new GrokSkillStager({
			workingDirectory: worktree,
			plugins: [{ type: "local", path: userPlugin }],
			skills: ["custom-user"],
		}).stage();

		const exclude = readFileSync(join(worktree, ".git", "info", "exclude"), {
			encoding: "utf-8",
		});
		expect(exclude.split(/\r?\n/)).toContain(".agents/");

		const status = execFileSync("git", ["status", "--short"], {
			cwd: worktree,
			encoding: "utf-8",
		});
		expect(status).not.toContain(".agents");
	});
});
