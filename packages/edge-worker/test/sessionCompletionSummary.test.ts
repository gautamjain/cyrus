import { describe, expect, it } from "vitest";
import { getSessionErrorReply } from "../src/sessionCompletionSummary.js";

describe("getSessionErrorReply", () => {
	it("returns null for successful sessions so existing reply logic is used", () => {
		expect(
			getSessionErrorReply([
				{
					type: "assistant",
					message: {
						content: [{ type: "text", text: "All good." }],
					},
				},
				{
					type: "result",
					subtype: "success",
					is_error: false,
					errors: [],
				},
			]),
		).toBeNull();
	});

	it("returns null when there is no result message", () => {
		expect(
			getSessionErrorReply([
				{
					type: "assistant",
					message: {
						content: [{ type: "text", text: "Working…" }],
					},
				},
			]),
		).toBeNull();
	});

	it("formats error_during_execution with the error detail", () => {
		const reply = getSessionErrorReply([
			{
				type: "assistant",
				message: {
					content: [
						{
							type: "tool_use",
							id: "t1",
							name: "Bash",
							input: {},
						},
					],
				},
			},
			{
				type: "result",
				subtype: "error_during_execution",
				is_error: true,
				errors: [
					"ACP request idle timeout: session/prompt (no activity for 300000ms)",
				],
			},
		]);

		expect(reply).toContain("**Task failed**");
		expect(reply).toContain("ACP request idle timeout");
		expect(reply).not.toContain("Task completed");
	});

	it("lists multiple errors", () => {
		const reply = getSessionErrorReply([
			{
				type: "result",
				subtype: "error_during_execution",
				is_error: true,
				errors: ["first", "second"],
			},
		]);

		expect(reply).toContain("- first");
		expect(reply).toContain("- second");
	});

	it("falls back to subtype when errors[] is empty", () => {
		const reply = getSessionErrorReply([
			{
				type: "result",
				subtype: "error_max_turns",
				is_error: true,
				errors: [],
			},
		]);

		expect(reply).toContain("**Task failed**");
		expect(reply).toContain("error_max_turns");
	});
});
