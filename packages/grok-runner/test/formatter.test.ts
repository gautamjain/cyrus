import { describe, expect, it } from "vitest";
import { GrokMessageFormatter } from "../src/formatter.js";

describe("GrokMessageFormatter", () => {
	const formatter = new GrokMessageFormatter();

	it("formats bash command parameters", () => {
		expect(
			formatter.formatToolParameter("Bash", {
				command: "ls -la",
				description: "list files",
			}),
		).toBe("ls -la");
	});

	it("formats read paths", () => {
		expect(
			formatter.formatToolParameter("Read", { file_path: "src/main.ts" }),
		).toBe("src/main.ts");
	});

	it("includes description in action name", () => {
		expect(
			formatter.formatToolActionName(
				"Bash",
				{ command: "npm test", description: "run tests" },
				false,
			),
		).toBe("Bash (run tests)");
	});

	it("truncates long results", () => {
		const long = "x".repeat(5000);
		const out = formatter.formatToolResult("Bash", {}, long, false);
		expect(out.length).toBeLessThan(long.length);
		expect(out).toContain("[truncated]");
	});
});
