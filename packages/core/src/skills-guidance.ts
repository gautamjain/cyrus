/**
 * Shared skills-guidance section for agent system prompts.
 *
 * Delimiters let runners replace the section without depending on wording
 * inside the body (so Claude vs Grok load instructions stay maintainable).
 */

export const SKILLS_GUIDANCE_START = "<!-- cyrus-skills-guidance -->";
export const SKILLS_GUIDANCE_END = "<!-- /cyrus-skills-guidance -->";

/** How the agent loads skill bodies at runtime. */
export type SkillLoadPath = "skill-tool" | "skill-md-read";

const WORKFLOW_LINES = [
	"Choose the appropriate skill based on the context:",
	"",
	"- **Code changes requested** (feature, bug fix, refactor): Use `implementation` to write code, then `verify-and-ship` to run checks and create a PR, then `summarize` to narrate results.",
	"- **Bug report or error**: Use `debug` to reproduce, root-cause, and fix, then `verify-and-ship`, then `summarize`.",
	"- **Question or research request**: Use `investigate` to search the codebase and provide an answer, then `summarize`.",
	"- **PR review feedback** (changes requested): Use `implementation` to address review comments, then `verify-and-ship`.",
	"",
	"Analyze the issue description, labels, and any user comments to determine which workflow fits. " +
		"Do NOT skip the verify-and-ship step if you made code changes — it ensures quality checks pass and a PR is created.",
].join("\n");

/**
 * Build the full delimited skills guidance block.
 *
 * @param skillNames discovered skill ids (already scoped)
 * @param skillLoadPath how this runner loads skill bodies
 */
export function formatSkillsGuidance(
	skillNames: string[],
	skillLoadPath: SkillLoadPath = "skill-tool",
): string {
	if (skillNames.length === 0) {
		return "";
	}

	const skillsList = skillNames.map((s) => `\`${s}\``).join(", ");

	const availability =
		skillLoadPath === "skill-md-read"
			? [
					`You have skills available: ${skillsList}`,
					"",
					"Grok has no Skill tool. Load a skill by reading its SKILL.md " +
						"(absolute paths appear in the session skill listing; managed skills " +
						"are under .agents/skills/<name>/SKILL.md).",
				].join("\n")
			: `You have skills available via the Skill tool: ${skillsList}`;

	const body = ["## Skills", "", availability, "", WORKFLOW_LINES].join("\n");

	return (
		"\n\n" + SKILLS_GUIDANCE_START + "\n" + body + "\n" + SKILLS_GUIDANCE_END
	);
}

/**
 * Replace an existing delimited skills section, or append if none is present.
 */
export function replaceSkillsGuidance(
	systemPrompt: string,
	newGuidance: string,
): string {
	if (!newGuidance) {
		return systemPrompt;
	}

	const pattern = new RegExp(
		`${escapeRegExp(SKILLS_GUIDANCE_START)}[\\s\\S]*?${escapeRegExp(SKILLS_GUIDANCE_END)}`,
	);

	if (pattern.test(systemPrompt)) {
		return systemPrompt.replace(pattern, () =>
			newGuidance.replace(/^\n+/, "").replace(/\n+$/, ""),
		);
	}

	// Legacy prompts without delimiters: append Grok guidance rather than
	// leave Claude Skill-tool text as the only instruction.
	return systemPrompt + newGuidance;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
