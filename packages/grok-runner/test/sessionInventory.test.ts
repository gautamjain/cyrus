import { describe, expect, it } from "vitest";
import {
	listAvailableInitTools,
	listInitSlashCommands,
} from "../src/sessionInventory.js";
import { translateToolRules } from "../src/toolPolicy.js";

describe("listAvailableInitTools", () => {
	it("lists default tools when unrestricted", () => {
		const policy = translateToolRules(undefined, undefined);
		const tools = listAvailableInitTools(policy);
		expect(tools).toContain("Read");
		expect(tools).toContain("Bash");
		expect(tools).toContain("Edit");
		expect(tools).toContain("search_tool");
	});

	it("omits tools that are blanket-denied", () => {
		const policy = translateToolRules(["Read(**)"], undefined);
		const tools = listAvailableInitTools(policy);
		expect(tools).toContain("Read");
		expect(tools).not.toContain("Bash");
		expect(tools).not.toContain("Edit");
		expect(tools).not.toContain("Write");
	});
});

describe("listInitSlashCommands", () => {
	it("returns staged skill names", () => {
		expect(listInitSlashCommands(["implementation", "summarize"])).toEqual([
			"implementation",
			"summarize",
		]);
	});
});
