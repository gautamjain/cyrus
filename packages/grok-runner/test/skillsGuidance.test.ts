import { describe, expect, it } from "vitest";
import { adaptSkillsGuidanceForGrok } from "../src/skillsGuidance.js";

const claudeShaped = `## Skills

You have skills available via the Skill tool: \`implementation\`, \`verify-and-ship\`, \`summarize\`

Choose the appropriate skill based on the context:

- **Code changes requested** (feature, bug fix, refactor): Use \`implementation\` to write code, then \`verify-and-ship\` to run checks and create a PR, then \`summarize\` to narrate results.
`;

describe("adaptSkillsGuidanceForGrok", () => {
	it("rewrites Skill tool wording and documents SKILL.md load path", () => {
		const out = adaptSkillsGuidanceForGrok(claudeShaped);
		expect(out).not.toContain("via the Skill tool");
		expect(out).toContain("You have skills available:");
		expect(out).toContain("`implementation`");
		expect(out).toContain("Grok has no Skill tool");
		expect(out).toContain("SKILL.md");
		expect(out).toContain(".agents/skills/<name>/SKILL.md");
		expect(out).toContain("Choose the appropriate skill based on the context:");
	});

	it("leaves prompts without Skill-tool phrasing unchanged", () => {
		const plain = "No skills section here.";
		expect(adaptSkillsGuidanceForGrok(plain)).toBe(plain);
	});
});
