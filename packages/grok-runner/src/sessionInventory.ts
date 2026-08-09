/**
 * Session inventory for Grok system/init messages (Codex-style diagnostics).
 *
 * Grok Build exposes tools by wire name; Cyrus activity logs prefer Claude-ish
 * bus names. Skills and slash commands come from staged managed skills.
 */

import { splitRule } from "cyrus-core";
import type { GrokToolPolicy } from "./toolPolicy.js";

/** Default Grok Build agent tools (bus name for Cyrus init/logs). */
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

/**
 * Tools available under the current permission policy (not blanket-denied).
 */
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

/**
 * Slash commands known at session start: staged skills are user-invocable
 * slash commands. Built-in Grok slash commands arrive later via ACP
 * available_commands_update and are not claimed here.
 */
export function listInitSlashCommands(stagedSkillNames: string[]): string[] {
	return [...stagedSkillNames];
}
