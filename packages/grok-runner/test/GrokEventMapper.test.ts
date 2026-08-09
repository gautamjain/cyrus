import type { SDKMessage } from "cyrus-core";
import { describe, expect, it } from "vitest";
import type { AcpSessionUpdate } from "../src/backend/acpTypes.js";
import {
	GrokEventMapper,
	projectGrokToolName,
} from "../src/GrokEventMapper.js";

function collectMapper(
	stagedSkills: string[] = [],
	tools: string[] = ["Read", "Bash", "Edit"],
) {
	const messages: SDKMessage[] = [];
	let sessionId = "pending";
	const mapper = new GrokEventMapper({
		workingDirectory: "/tmp/work",
		model: "grok-4.5",
		getSessionId: () => sessionId,
		getStagedSkillNames: () => stagedSkills,
		getAvailableTools: () => tools,
		getSlashCommands: () => stagedSkills,
		emitMessage: (m) => messages.push(m),
		onSessionId: (id) => {
			sessionId = id;
		},
	});
	return { mapper, messages, getSessionId: () => sessionId };
}

describe("projectGrokToolName", () => {
	it("maps built-in tools to Claude-ish names", () => {
		expect(projectGrokToolName("run_terminal_command")).toBe("Bash");
		expect(projectGrokToolName("read_file")).toBe("Read");
		expect(projectGrokToolName("search_replace")).toBe("Edit");
		expect(projectGrokToolName("list_dir")).toBe("Glob");
		expect(projectGrokToolName("grep")).toBe("Grep");
	});

	it("maps MCP-style names", () => {
		expect(projectGrokToolName("Grok__search_web")).toBe(
			"mcp__Grok__search_web",
		);
	});
});

describe("GrokEventMapper", () => {
	it("marks cancelled tools as errors with Tool cancelled text", () => {
		const messages: import("cyrus-core").SDKMessage[] = [];
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
			toolCallId: "c-cancel",
			_meta: { "x.ai/tool": { name: "read_file" } },
			rawInput: { target_file: "x" },
		});
		mapper.handleUpdate({
			sessionUpdate: "tool_call_update",
			toolCallId: "c-cancel",
			status: "cancelled",
		});
		const result = messages.find(
			(m) =>
				m.type === "user" &&
				Array.isArray((m as any).message?.content) &&
				(m as any).message.content[0]?.type === "tool_result",
		) as any;
		expect(result?.message.content[0].is_error).toBe(true);
		expect(result?.message.content[0].content).toBe("Tool cancelled");
	});

	it("emits tools, skills, and slash_commands on init", () => {
		const { mapper, messages } = collectMapper(
			["implementation", "verify-and-ship"],
			["Read", "Bash"],
		);
		mapper.emitInit("sess-skills", "grok-4.5");
		const init = messages[0] as {
			type: string;
			subtype?: string;
			skills?: string[];
			tools?: string[];
			slash_commands?: string[];
		};
		expect(init.type).toBe("system");
		expect(init.subtype).toBe("init");
		expect(init.skills).toEqual(["implementation", "verify-and-ship"]);
		expect(init.slash_commands).toEqual(["implementation", "verify-and-ship"]);
		expect(init.tools).toEqual(["Read", "Bash"]);
	});

	it("emits init, tool_use, tool_result, assistant text, and result", () => {
		const { mapper, messages, getSessionId } = collectMapper();

		mapper.emitInit("sess-1", "grok-4.5");
		expect(getSessionId()).toBe("sess-1");
		expect(messages[0]?.type).toBe("system");

		const toolCall: AcpSessionUpdate = {
			sessionUpdate: "tool_call",
			toolCallId: "call-1",
			title: "read_file",
			rawInput: { target_file: "/tmp/work/hello.txt" },
			_meta: {
				"x.ai/tool": { name: "read_file", kind: "read" },
			},
		};
		mapper.handleUpdate(toolCall);

		const toolDone: AcpSessionUpdate = {
			sessionUpdate: "tool_call_update",
			toolCallId: "call-1",
			status: "completed",
			content: [
				{
					type: "content",
					content: { type: "text", text: "hello\n" },
				},
			],
		};
		mapper.handleUpdate(toolDone);

		mapper.handleUpdate({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "Done." },
		});

		mapper.finalize({ stopReason: "EndTurn" });

		const types = messages.map((m) => m.type);
		expect(types).toContain("system");
		expect(types).toContain("assistant");
		expect(types).toContain("user");
		expect(types).toContain("result");

		const toolUse = messages.find(
			(m) =>
				m.type === "assistant" &&
				Array.isArray(
					(m as { message?: { content?: unknown[] } }).message?.content,
				) &&
				(m as { message: { content: Array<{ type: string; name?: string }> } })
					.message.content[0]?.type === "tool_use",
		) as { message: { content: Array<{ name: string }> } } | undefined;
		expect(toolUse?.message.content[0]?.name).toBe("Read");

		const result = messages.find((m) => m.type === "result") as {
			subtype: string;
			result?: string;
		};
		expect(result?.subtype).toBe("success");
		expect(result?.result).toBe("Done.");
	});
});
