import { describe, expect, it } from "vitest";
import {
	formatSkillsGuidance,
	replaceSkillsGuidance,
	SKILLS_GUIDANCE_END,
	SKILLS_GUIDANCE_START,
} from "../src/skills-guidance.js";

describe("formatSkillsGuidance", () => {
	it("builds skill-tool wording by default", () => {
		const out = formatSkillsGuidance(["implementation", "summarize"]);
		expect(out).toContain(SKILLS_GUIDANCE_START);
		expect(out).toContain(SKILLS_GUIDANCE_END);
		expect(out).toContain("via the Skill tool");
		expect(out).toContain("`implementation`");
		expect(out).toContain("Choose the appropriate skill based on the context:");
	});

	it("builds skill-md-read wording for Grok", () => {
		const out = formatSkillsGuidance(["implementation"], "skill-md-read");
		expect(out).not.toContain("via the Skill tool");
		expect(out).toContain("Grok has no Skill tool");
		expect(out).toContain("SKILL.md");
	});

	it("returns empty string for no skills", () => {
		expect(formatSkillsGuidance([])).toBe("");
	});
});

describe("replaceSkillsGuidance", () => {
	it("swaps the delimited section without depending on body wording", () => {
		const claude = formatSkillsGuidance(["a"], "skill-tool");
		const grok = formatSkillsGuidance(["a"], "skill-md-read");
		const prompt = `Head.${claude}\nTail.`;
		const out = replaceSkillsGuidance(prompt, grok);
		expect(out).toContain("Head.");
		expect(out).toContain("Tail.");
		expect(out).not.toContain("via the Skill tool");
		expect(out).toContain("Grok has no Skill tool");
	});
});
