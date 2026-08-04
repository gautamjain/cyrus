import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	type Dirent,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";

interface GrokSkillSource {
	name: string;
	path: string;
}

/**
 * Structural subset of the SDK plugin config we read here. Typed locally to
 * avoid a direct dependency on the Claude Agent SDK from this package.
 */
interface LocalPluginLike {
	type?: string;
	path?: unknown;
}

/** Inputs the skill stager needs from a runner config. */
export interface SkillStagingInput {
	workingDirectory?: string;
	additionalDirectories?: string[];
	/**
	 * Which skills to stage (same semantics as Codex / AgentRunnerConfig):
	 * - `undefined` or `"all"`: stage every skill found under plugins + repo roots
	 * - `string[]` with names: stage only those names (Edge scope allow-list)
	 * - `[]` (empty array): stage nothing
	 */
	skills?: string[] | "all";
	plugins?: LocalPluginLike[];
}

/**
 * Stages managed + repo-local skills into Grok's discovery layout
 * (`<workingDirectory>/.agents/skills/<name>` symlinks) before a run, and
 * removes them afterwards.
 *
 * Mirrors {@link CodexSkillStager}: EdgeWorker already resolves user plugins
 * first so same-named user skills shadow internal ones; the `seen` set here
 * keeps the first source for each name (user → internal → repo-local).
 */
export class GrokSkillStager {
	private stagedSkillPaths: string[] = [];

	constructor(private readonly input: SkillStagingInput) {}

	/** Names of skills currently staged (for logs / session diagnostics). */
	getStagedSkillNames(): string[] {
		return this.stagedSkillPaths.map((p) => basename(p));
	}

	/** Stage allowed skills as symlinks. Idempotent: clears prior staging first. */
	stage(): void {
		this.cleanup();

		const skillSources = this.discoverSkillSources();
		if (skillSources.length === 0) {
			return;
		}

		const skillsRoot = this.resolveManagedSkillsRoot();
		if (!skillsRoot) {
			return;
		}
		mkdirSync(skillsRoot, { recursive: true });
		this.ensureManagedSkillsIgnored();

		for (const source of skillSources) {
			const target = join(skillsRoot, source.name);
			if (this.stageSkillDirectory(source, target)) {
				this.stagedSkillPaths.push(target);
			}
		}
	}

	/** Remove all staged skill symlinks. Best-effort; never throws. */
	cleanup(): void {
		for (const target of this.stagedSkillPaths) {
			try {
				if (this.isStagedSkillPath(target)) {
					rmSync(target, { recursive: true, force: true });
				}
			} catch {
				// Best-effort cleanup: never mask the session result.
			}
		}
		this.stagedSkillPaths = [];
	}

	private discoverSkillSources(): GrokSkillSource[] {
		const configuredSkills = this.input.skills;
		// Empty allow-list = stage nothing. "all" / undefined = no name filter.
		if (Array.isArray(configuredSkills) && configuredSkills.length === 0) {
			return [];
		}
		const allowedSkillNames =
			Array.isArray(configuredSkills) && configuredSkills.length > 0
				? new Set(configuredSkills)
				: null;

		const sources: GrokSkillSource[] = [];
		const seen = new Set<string>();
		const addFromSkillsDirectory = (skillsDirectory: string): void => {
			for (const source of this.readSkillSources(skillsDirectory)) {
				if (allowedSkillNames && !allowedSkillNames.has(source.name)) {
					continue;
				}
				if (seen.has(source.name)) {
					continue;
				}
				seen.add(source.name);
				sources.push(source);
			}
		};

		// Plugins first (EdgeWorker lists user plugin before internal → overrides).
		for (const plugin of this.input.plugins ?? []) {
			if (plugin.type !== "local" || typeof plugin.path !== "string") {
				continue;
			}
			addFromSkillsDirectory(join(plugin.path, "skills"));
		}

		for (const directory of this.getRepoLocalSkillRoots()) {
			addFromSkillsDirectory(join(directory, ".claude", "skills"));
		}

		return sources;
	}

	private resolveManagedSkillsRoot(): string | undefined {
		const workingDirectory = this.input.workingDirectory;
		if (!workingDirectory) {
			return undefined;
		}
		return join(workingDirectory, ".agents", "skills");
	}

	private ensureManagedSkillsIgnored(): void {
		const workingDirectory = this.input.workingDirectory;
		if (!workingDirectory) {
			return;
		}

		try {
			const rawExcludePath = execFileSync(
				"git",
				["rev-parse", "--git-path", "info/exclude"],
				{
					cwd: workingDirectory,
					encoding: "utf-8",
					stdio: ["ignore", "pipe", "ignore"],
				},
			).trim();
			if (!rawExcludePath) {
				return;
			}
			const excludePath = isAbsolute(rawExcludePath)
				? rawExcludePath
				: join(workingDirectory, rawExcludePath);

			mkdirSync(dirname(excludePath), { recursive: true });
			const existing = existsSync(excludePath)
				? readFileSync(excludePath, "utf-8")
				: "";
			if (existing.split(/\r?\n/).includes(".agents/")) {
				return;
			}

			const prefix =
				existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
			appendFileSync(excludePath, `${prefix}.agents/\n`);
		} catch {
			// Non-git chat workspaces and restricted git metadata are fine; cleanup
			// still removes staged symlinks, and the exclude is only for git hygiene.
		}
	}

	private getRepoLocalSkillRoots(): string[] {
		const roots = new Set<string>();
		if (this.input.workingDirectory) {
			roots.add(this.input.workingDirectory);
		}
		for (const directory of this.input.additionalDirectories ?? []) {
			if (directory) {
				roots.add(directory);
			}
		}
		return [...roots];
	}

	private readSkillSources(skillsDirectory: string): GrokSkillSource[] {
		let entries: Dirent[];
		try {
			entries = readdirSync(skillsDirectory, { withFileTypes: true });
		} catch {
			return [];
		}

		return entries
			.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
			.map((entry) => ({
				name: entry.name,
				path: join(skillsDirectory, entry.name),
			}))
			.filter((source) => existsSync(join(source.path, "SKILL.md")));
	}

	private stageSkillDirectory(
		source: GrokSkillSource,
		target: string,
	): boolean {
		if (existsSync(target)) {
			console.warn(
				`[GrokRunner] Skipping managed skill '${source.name}' because ${target} already exists`,
			);
			return false;
		}

		try {
			symlinkSync(source.path, target, "dir");
			return true;
		} catch (error) {
			console.warn(
				`[GrokRunner] Failed to stage managed skill '${source.name}' for Grok: ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}

	private isStagedSkillPath(path: string): boolean {
		try {
			const stat = lstatSync(path);
			return stat.isDirectory() || stat.isSymbolicLink();
		} catch {
			return false;
		}
	}
}
