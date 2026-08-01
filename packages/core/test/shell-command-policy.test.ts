import { describe, expect, it } from "vitest";
import {
	commandMatchesAllowedBash,
	compileBashPattern,
	grantsUnrestrictedBash,
	hasBashGrant,
	splitShellCommands,
} from "../src/shell-command-policy.js";

/**
 * Engine-agnostic shell grant matching (ported from LinkedList CYR-20 / CYR-48).
 * Kept free of runner presets so this suite only pins the pure matcher.
 */
describe("splitShellCommands", () => {
	it("returns a lone command unchanged", () => {
		expect(splitShellCommands("git status")).toEqual(["git status"]);
	});

	it("splits on && ; | || & and newlines", () => {
		expect(splitShellCommands("git status && sed -i s/a/b/ f")).toEqual([
			"git status",
			"sed -i s/a/b/ f",
		]);
		expect(splitShellCommands("a; b")).toEqual(["a", "b"]);
		expect(splitShellCommands("a | b")).toEqual(["a", "b"]);
	});

	it("treats operators inside quotes as data", () => {
		expect(splitShellCommands('echo "a && b"')).toEqual(['echo "a && b"']);
	});

	it("fails closed on unterminated quotes", () => {
		expect(splitShellCommands('echo "unterminated')).toBeNull();
	});
});

describe("commandMatchesAllowedBash", () => {
	const grants = ["Bash(git diff:*)", "Bash(git log:*)"];

	it("allows a command inside a grant", () => {
		expect(commandMatchesAllowedBash("git diff origin/main", grants)).toBe(
			true,
		);
	});

	it("refuses a command outside every grant", () => {
		expect(commandMatchesAllowedBash("sed -i s/a/b/ f", grants)).toBe(false);
	});

	it("refuses a chain that smuggles a denied command", () => {
		expect(
			commandMatchesAllowedBash("git diff HEAD && sed -i s/a/b/ f", grants),
		).toBe(false);
	});

	it("allows a chain when every segment is granted", () => {
		expect(
			commandMatchesAllowedBash(
				"git diff HEAD && git log --oneline -5",
				grants,
			),
		).toBe(true);
	});

	it("treats mid-pattern * as a wildcard", () => {
		const grant = ["Bash(git -C * pull)"];
		expect(commandMatchesAllowedBash("git -C /repo pull", grant)).toBe(true);
		expect(commandMatchesAllowedBash("git -C /repo push", grant)).toBe(false);
	});
});

describe("grantsUnrestrictedBash / hasBashGrant", () => {
	it("detects bare Bash as unrestricted", () => {
		expect(grantsUnrestrictedBash(["Read", "Bash"])).toBe(true);
		expect(grantsUnrestrictedBash(["Bash(git:*)"])).toBe(false);
	});

	it("detects any Bash grant", () => {
		expect(hasBashGrant(["Read"])).toBe(false);
		expect(hasBashGrant(["Bash(git:*)"])).toBe(true);
		expect(hasBashGrant(["Bash"])).toBe(true);
	});
});

describe("compileBashPattern", () => {
	it("anchors the pattern", () => {
		const re = compileBashPattern("git status");
		expect(re).not.toBe("match-all");
		if (re !== "match-all") {
			expect(re.test("git status")).toBe(true);
			expect(re.test("not git status")).toBe(false);
		}
	});
});
