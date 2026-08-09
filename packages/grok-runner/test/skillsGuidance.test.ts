import { formatSkillsGuidance } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { applyGrokSkillsGuidance } from "../src/skillsGuidance.js";

describe("applyGrokSkillsGuidance", () => {
	it("replaces the delimited Claude skills section with skill-md-read wording", () => {
		const claude = formatSkillsGuidance(
			["implementation", "verify-and-ship"],
			"skill-tool",
		);
		const prompt = `Intro text.${claude}\n\nTrailing.`;
		const out = applyGrokSkillsGuidance(prompt, [
			"implementation",
			"verify-and-ship",
		]);

		expect(out).toContain("Intro text.");
		expect(out).toContain("Trailing.");
		expect(out).not.toContain("via the Skill tool");
		expect(out).toContain("Grok has no Skill tool");
		expect(out).toContain("SKILL.md");
		expect(out).toContain("`implementation`");
		expect(out).toContain("<!-- cyrus-skills-guidance -->");
	});

	it("appends Grok guidance when no delimited section exists", () => {
		const out = applyGrokSkillsGuidance("No skills section.", [
			"implementation",
		]);
		expect(out.startsWith("No skills section.")).toBe(true);
		expect(out).toContain("Grok has no Skill tool");
		expect(out).toContain("`implementation`");
	});
});
