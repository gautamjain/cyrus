/**
 * Apply Grok-accurate skills load instructions to the session system prompt.
 *
 * EdgeWorker still builds Claude-shaped guidance (Skill tool) for all runners.
 * On the Grok path only, replace the delimited skills section with skill-md-read
 * wording. Uses stable delimiters from cyrus-core — not string matching on body text.
 */

import { formatSkillsGuidance, replaceSkillsGuidance } from "cyrus-core";

export function applyGrokSkillsGuidance(
	systemPrompt: string,
	skillNames: string[],
): string {
	const grokSection = formatSkillsGuidance(skillNames, "skill-md-read");
	return replaceSkillsGuidance(systemPrompt, grokSection);
}
