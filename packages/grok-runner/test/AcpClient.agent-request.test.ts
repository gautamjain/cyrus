import { describe, expect, it } from "vitest";
import { defaultHandleAgentRequest } from "../src/backend/AcpClient.js";

describe("defaultHandleAgentRequest", () => {
	it("auto-approves session/request_permission with AllowOnce option", () => {
		const result = defaultHandleAgentRequest("session/request_permission", {
			options: [
				{ optionId: "deny", kind: "reject_once", name: "Deny" },
				{ optionId: "allow-once", kind: "allow_once", name: "Allow once" },
			],
		}) as { outcome: { outcome: string; optionId?: string } };

		expect(result.outcome.outcome).toBe("selected");
		expect(result.outcome.optionId).toBe("allow-once");
	});

	it("falls back to first option when no allow kind", () => {
		const result = defaultHandleAgentRequest("session/request_permission", {
			options: [{ optionId: "opt-a", kind: "other", name: "A" }],
		}) as { outcome: { outcome: string; optionId?: string } };

		expect(result.outcome.outcome).toBe("selected");
		expect(result.outcome.optionId).toBe("opt-a");
	});

	it("cancels when no options", () => {
		const result = defaultHandleAgentRequest("session/request_permission", {
			options: [],
		}) as { outcome: { outcome: string } };
		expect(result.outcome.outcome).toBe("cancelled");
	});

	it("rejects unimplemented fs methods", () => {
		expect(() =>
			defaultHandleAgentRequest("fs/read_text_file", { path: "/tmp/x" }),
		).toThrow(/not implemented/i);
	});
});
