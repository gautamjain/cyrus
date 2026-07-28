import { describe, expect, it } from "vitest";
import { translateToolRule, translateToolRules } from "../src/toolPolicy.js";

/**
 * Cyrus's real `readOnly` preset (packages/claude-runner/src/config.ts). Most of
 * these names mean nothing to Grok — the point of the translation is that the
 * ones that matter survive and the rest are reported rather than assumed.
 */
const CYRUS_READ_ONLY = [
	"Read(**)",
	"WebFetch",
	"WebSearch",
	"TaskCreate",
	"TaskUpdate",
	"TaskGet",
	"TaskList",
	"Task",
	"Skill",
];

describe("translateToolRule", () => {
	it("passes through tool names Grok already recognizes", () => {
		for (const rule of [
			"Read(**)",
			"Edit(**/*.rs)",
			"Write",
			"Grep",
			"Glob",
			"WebFetch",
			"WebSearch",
			"NotebookEdit",
			"*",
		]) {
			expect(translateToolRule(rule)).toBe(rule);
		}
	});

	it("keeps Claude's Bash prefix forms intact", () => {
		expect(translateToolRule("Bash")).toBe("Bash");
		expect(translateToolRule("Bash(git:*)")).toBe("Bash(git:*)");
		expect(translateToolRule("Bash(git *)")).toBe("Bash(git *)");
	});

	it("rewrites a whole-server MCP grant into a Grok glob", () => {
		// The critical one: `mcp__linear` passed through verbatim matches nothing
		// in Grok, so a reviewer would be unable to post its findings back.
		expect(translateToolRule("mcp__linear")).toBe("MCPTool(linear__*)");
	});

	it("rewrites a single-tool MCP grant", () => {
		expect(translateToolRule("mcp__linear__create_comment")).toBe(
			"MCPTool(linear__create_comment)",
		);
	});

	it("returns null for tools Grok has no concept of", () => {
		for (const rule of ["Task", "Skill", "TaskCreate", "SendMessage", ""]) {
			expect(translateToolRule(rule)).toBeNull();
		}
	});
});

describe("translateToolRules", () => {
	it("denies every mutating tool for a read-only session", () => {
		const policy = translateToolRules([...CYRUS_READ_ONLY, "mcp__linear"]);

		expect(policy.allow).toEqual([
			"Read(**)",
			"WebFetch",
			"WebSearch",
			"MCPTool(linear__*)",
		]);
		// The teeth: enforced in every mode, including --always-approve.
		expect(policy.deny).toEqual(["Edit", "Write", "NotebookEdit", "Bash"]);
		expect(policy.scopedBashUnenforceable).toBe(false);
	});

	it("reports Cyrus tool names that Grok silently ignores", () => {
		const policy = translateToolRules(CYRUS_READ_ONLY);
		expect(policy.untranslated).toEqual([
			"TaskCreate",
			"TaskUpdate",
			"TaskGet",
			"TaskList",
			"Task",
			"Skill",
		]);
	});

	it("does not restrict anything when no allow-list is configured", () => {
		const policy = translateToolRules(undefined, undefined);
		expect(policy.allow).toEqual([]);
		expect(policy.deny).toEqual([]);
	});

	it("still applies explicit denies without an allow-list", () => {
		const policy = translateToolRules(undefined, ["Bash", "mcp__github"]);
		expect(policy.deny).toEqual(["Bash", "MCPTool(github__*)"]);
	});

	it("leaves Bash unrestricted when the allow-list scopes it, and flags why", () => {
		// `deny` beats `allow` in Grok regardless of specificity, so denying Bash
		// wholesale would also kill the `git` commands the review persona needs.
		const policy = translateToolRules([
			"Read(**)",
			"Bash(git:*)",
			"mcp__linear",
		]);

		expect(policy.deny).toEqual(["Edit", "Write", "NotebookEdit"]);
		expect(policy.deny).not.toContain("Bash");
		expect(policy.scopedBashUnenforceable).toBe(true);
	});

	it("keeps Bash usable when it is granted unscoped", () => {
		const policy = translateToolRules(["Read(**)", "Bash"]);
		expect(policy.deny).toEqual(["Edit", "Write", "NotebookEdit"]);
		expect(policy.scopedBashUnenforceable).toBe(false);
	});

	it("treats a wildcard grant as unrestricted", () => {
		const policy = translateToolRules(["*"]);
		expect(policy.deny).toEqual([]);
	});

	it("does not restrict when an allow-list translates to nothing", () => {
		// Every entry was dropped, so we know nothing about intent — inventing a
		// deny-all here would break sessions rather than secure them.
		const policy = translateToolRules(["Task", "Skill"]);
		expect(policy.allow).toEqual([]);
		expect(policy.deny).toEqual([]);
		expect(policy.untranslated).toEqual(["Task", "Skill"]);
	});

	it("de-duplicates repeated rules", () => {
		const policy = translateToolRules(
			["Read(**)", "Read(**)", "mcp__linear", "mcp__linear"],
			["Bash", "Bash"],
		);
		expect(policy.allow).toEqual(["Read(**)", "MCPTool(linear__*)"]);
		expect(policy.deny.filter((r) => r === "Bash")).toHaveLength(1);
	});
});
