import type { SDKMessage } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { GrokEventMapper } from "../src/GrokEventMapper.js";

describe("GrokEventMapper suppressUpdates", () => {
	it("ignores updates while suppress is on (load replay)", () => {
		const messages: SDKMessage[] = [];
		const mapper = new GrokEventMapper({
			workingDirectory: "/tmp",
			getSessionId: () => "s1",
			getStagedSkillNames: () => [],
			getAvailableTools: () => ["Read"],
			getSlashCommands: () => [],
			emitMessage: (m) => messages.push(m),
			onSessionId: () => {},
		});

		mapper.emitInit("s1", "grok-4.5");
		expect(messages).toHaveLength(1);

		mapper.setSuppressUpdates(true);
		mapper.handleUpdate({
			sessionUpdate: "tool_call",
			toolCallId: "call-1",
			title: "read_file",
			rawInput: { target_file: "x" },
			_meta: { "x.ai/tool": { name: "read_file" } },
		});
		mapper.handleUpdate({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "replayed history" },
		});
		// Still only init
		expect(messages).toHaveLength(1);

		mapper.setSuppressUpdates(false);
		mapper.handleUpdate({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "new turn" },
		});
		mapper.finalize({ stopReason: "EndTurn" });

		const texts = messages
			.filter((m) => m.type === "assistant")
			.map((m) => {
				const c = (m as { message?: { content?: Array<{ text?: string }> } })
					.message?.content;
				return c?.[0]?.text;
			});
		expect(texts).toContain("new turn");
		expect(texts.join("")).not.toContain("replayed history");
	});

	it("dedupes multiple completed tool_call_update for same id", () => {
		const messages: SDKMessage[] = [];
		const mapper = new GrokEventMapper({
			workingDirectory: "/tmp",
			getSessionId: () => "s1",
			getStagedSkillNames: () => [],
			getAvailableTools: () => ["Read"],
			getSlashCommands: () => [],
			emitMessage: (m) => messages.push(m),
			onSessionId: () => {},
		});
		mapper.emitInit("s1");
		mapper.handleUpdate({
			sessionUpdate: "tool_call",
			toolCallId: "call-1",
			_meta: { "x.ai/tool": { name: "read_file" } },
			rawInput: { target_file: "a" },
		});
		const done = {
			sessionUpdate: "tool_call_update" as const,
			toolCallId: "call-1",
			status: "completed",
			content: [{ type: "content", content: { type: "text", text: "ok" } }],
		};
		mapper.handleUpdate(done);
		mapper.handleUpdate(done);

		const results = messages.filter(
			(m) =>
				m.type === "user" &&
				Array.isArray((m as any).message?.content) &&
				(m as any).message.content[0]?.type === "tool_result",
		);
		expect(results).toHaveLength(1);
	});
});
