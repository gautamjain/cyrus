import { splitRule } from "cyrus-core";
import type { GrokToolPolicy } from "./toolPolicy.js";

const GROK_DEFAULT_BUS_TOOLS = [
	"Read",
	"Bash",
	"Edit",
	"Write",
	"Glob",
	"Grep",
	"TodoWrite",
	"search_tool",
	"use_tool",
] as const;

export function listAvailableInitTools(policy: GrokToolPolicy): string[] {
	const blanketDenied = new Set<string>();
	for (const rule of policy.deny) {
		const { head, args } = splitRule(rule);
		if (head && args === undefined) {
			blanketDenied.add(head);
		}
	}

	return GROK_DEFAULT_BUS_TOOLS.filter((name) => !blanketDenied.has(name));
}

export function listInitSlashCommands(stagedSkillNames: string[]): string[] {
	return [...stagedSkillNames];
}
