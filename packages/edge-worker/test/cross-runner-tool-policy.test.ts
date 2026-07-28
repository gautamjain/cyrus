import { deriveBuiltInDisallowedTools } from "cyrus-claude-runner";
import {
	commandMatchesAllowedBash,
	grantsUnrestrictedBash,
	SLACK_DEFAULT_ALLOWED_TOOLS,
	splitShellCommands,
} from "cyrus-core";
import {
	evaluatePermissionRequest,
	translateToolRules,
} from "cyrus-grok-runner";
import { describe, expect, it } from "vitest";

/**
 * CYR-25 — cross-runner agreement on a fixed command matrix.
 *
 * No suite compared the two runners before this one, which is why a real
 * divergence took two live probes to find: on identical `readOnly` config,
 * Claude allowed `echo probe-ok` and Grok refused it (CYR-23 vs CYR-27). Since
 * PR #9 both import the same shell matcher from `cyrus-core`, so the matcher
 * was never the culprit — the divergence lives above it, and nothing pinned
 * that down.
 *
 * ## The divergence, and why it is not a security hole
 *
 * The cause is a read-only command classifier **inside Claude Code**, which
 * pre-approves commands it considers non-mutating — `git status`, `git log`,
 * `ls`, `echo` — *before* `canUseTool` runs. Grok has no equivalent layer, so
 * it refuses them. It is **not** `sandbox.autoAllowBashIfSandboxed`: measured
 * in review, the pre-approval fires with no `sandbox` key configured at all
 * (see `claude-runner/test/live-sdk-precedence.test.ts`).
 *
 * That divergence is confined to **non-mutating** commands. It is real and it
 * is documented here rather than papered over, because it cannot be removed
 * from Cyrus's side: the auto-allow lives inside the SDK and is not
 * configurable per-command. What matters for a restricted persona is that both
 * runners refuse every command that could *change* something, and that is what
 * these tests pin.
 *
 * The tests below compare each runner's real decision logic, not a
 * reimplementation of it.
 */

type Decision = "allow" | "deny";

/**
 * How Claude resolves a shell command, composing the two layers ClaudeRunner
 * actually installs: the derived deny rules (which the SDK evaluates first and
 * which survive both the sandbox auto-allow and settings-file shadowing) and
 * then the `canUseTool` scoped-grant check.
 */
function claudeDecision(allowedTools: string[], command: string): Decision {
	const denyRules = deriveBuiltInDisallowedTools(allowedTools).filter((rule) =>
		rule.startsWith("Bash("),
	);
	// Deny rules apply to every link of a chain, so a chain is only as
	// permitted as its least-permitted link.
	for (const link of splitShellCommands(command)) {
		if (denyRules.some((rule) => commandMatchesAllowedBash(link, [rule]))) {
			return "deny";
		}
	}
	if (grantsUnrestrictedBash(allowedTools)) {
		return "allow";
	}
	const grants = allowedTools.filter((entry) =>
		entry.trim().startsWith("Bash"),
	);
	return commandMatchesAllowedBash(command, grants) ? "allow" : "deny";
}

/** How Grok resolves the same command, through its real ACP client-side check. */
function grokDecision(allowedTools: string[], command: string): Decision {
	const policy = translateToolRules(
		allowedTools,
		deriveBuiltInDisallowedTools(allowedTools),
	);
	const result = evaluatePermissionRequest(
		{ toolCall: { kind: "execute", rawInput: { command } } },
		policy,
	);
	return result.allowed ? "allow" : "deny";
}

const READ_ONLY_PERSONA = [...SLACK_DEFAULT_ALLOWED_TOOLS];

/**
 * The matrix. Every command the two live probes disagreed on is here, plus the
 * mutating cases the whole ticket is about.
 */
const MATRIX: Array<{ command: string; expected: Decision; why: string }> = [
	{
		command: "git -C /repo pull",
		expected: "allow",
		why: "the persona's one explicit grant",
	},
	{
		command: "git status",
		expected: "deny",
		why: "outside the grant (see the divergence note — the SDK sandbox pre-approves this live)",
	},
	{
		command: "git log --oneline -3",
		expected: "deny",
		why: "outside the grant (pre-approved live, same as git status)",
	},
	{
		command: "echo probe-ok",
		expected: "deny",
		why: "outside the grant; this is the exact command the two live probes disagreed on",
	},
	{
		command: "sed -i '' 's/a/b/' file.txt",
		expected: "deny",
		why: "in-place write — the way around a denied Edit",
	},
	{
		command: "git commit -am wip",
		expected: "deny",
		why: "mutating git",
	},
	{
		command: "git push origin main",
		expected: "deny",
		why: "publishes code",
	},
	{
		command: "git -C /repo pull && sed -i '' 's/a/b/' file.txt",
		expected: "deny",
		why: "a chain is only as permitted as its least-permitted link",
	},
	{
		command: "rm -rf /tmp/x",
		expected: "deny",
		why: "destructive",
	},
];

describe("cross-runner tool policy agreement (CYR-25)", () => {
	describe("Claude and Grok reach the same decision for a readOnly persona", () => {
		for (const { command, expected, why } of MATRIX) {
			it(`${expected}s \`${command}\` on both runners — ${why}`, () => {
				const claude = claudeDecision(READ_ONLY_PERSONA, command);
				const grok = grokDecision(READ_ONLY_PERSONA, command);

				expect(
					claude,
					`Claude and Grok disagreed on \`${command}\`: claude=${claude} grok=${grok}`,
				).toBe(grok);
				expect(claude).toBe(expected);
			});
		}
	});

	describe("both runners leave an unrestricted builder unclamped", () => {
		const BUILDER = ["Read", "Write", "Edit", "Bash"];

		for (const command of [
			"git commit -am wip",
			"git push origin main",
			"sed -i '' 's/a/b/' file.txt",
			"rm -rf node_modules",
		]) {
			it(`allows \`${command}\` on both runners`, () => {
				expect(claudeDecision(BUILDER, command)).toBe("allow");
				expect(grokDecision(BUILDER, command)).toBe("allow");
			});
		}
	});

	it("keeps mcp__linear reachable on both runners", () => {
		// The read-only persona reports its findings through Linear. Neither
		// runner may deny it.
		const denied = deriveBuiltInDisallowedTools(READ_ONLY_PERSONA);
		expect(denied.some((rule) => rule.startsWith("mcp__"))).toBe(false);

		const policy = translateToolRules(READ_ONLY_PERSONA, denied);
		const result = evaluatePermissionRequest(
			{ toolCall: { kind: "other", name: "linear__create_comment" } },
			policy,
		);
		expect(result.allowed).toBe(true);
	});

	// Documents the known, measured gap so a future reader does not mistake the
	// matcher-level agreement above for live agreement.
	it("documents the read-only divergence the sandbox auto-allow creates", () => {
		// Our matcher denies these on both runners. Live, Claude allows them
		// because the SDK pre-approves them; Grok still refuses. The gap is
		// real, and every command in it is non-mutating.
		const preApprovedLive = [
			"git status",
			"git log --oneline -3",
			"echo probe-ok",
		];

		for (const command of preApprovedLive) {
			expect(claudeDecision(READ_ONLY_PERSONA, command)).toBe("deny");
			expect(grokDecision(READ_ONLY_PERSONA, command)).toBe("deny");
			// None of them can change anything, which is why the live gap is
			// tolerable while the mutating cases above are not.
			const denyRules = deriveBuiltInDisallowedTools(READ_ONLY_PERSONA);
			expect(
				denyRules.some((rule) => commandMatchesAllowedBash(command, [rule])),
			).toBe(false);
		}
	});
});
