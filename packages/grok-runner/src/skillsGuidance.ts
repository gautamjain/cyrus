/**
 * Rewrite Claude-centric skills guidance for Grok Build.
 *
 * Grok Build does not register a Skill tool. Skills load by reading SKILL.md
 * (session skill listing includes absolute paths) or via slash commands.
 * Cyrus EdgeWorker still injects Claude-shaped text ("via the Skill tool");
 * rewrite it only on the Grok path so Claude/Codex prompts stay unchanged.
 */
export function adaptSkillsGuidanceForGrok(text: string): string {
	const skillToolPhrase = "You have skills available via the Skill tool:";
	if (!text.includes(skillToolPhrase)) {
		return text;
	}

	return text
		.replace(skillToolPhrase, "You have skills available:")
		.replace(
			"Choose the appropriate skill based on the context:",
			"Grok has no Skill tool. Load a skill by reading its SKILL.md " +
				"(paths appear in the session skill listing; managed skills are under " +
				".agents/skills/<name>/SKILL.md).\n\n" +
				"Choose the appropriate skill based on the context:",
		);
}
