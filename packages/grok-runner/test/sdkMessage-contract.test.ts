/**
 * Contract tests: GrokEventMapper output must satisfy the shapes
 * AgentSessionManager.handleClaudeMessage() relies on (Claude SDKMessage bus).
 *
 * This is the integration surface between runners and Linear activity posting.
 * Spec sources:
 * - @anthropic-ai/claude-agent-sdk SDKMessage union (via cyrus-core)
 * - packages/edge-worker/src/AgentSessionManager.ts message switch
 * - ACP session/update → tool_call / tool_call_update lifecycle
 *   https://agentclientprotocol.com/protocol/prompt-turn
 */

import type { SDKMessage } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { GrokEventMapper } from "../src/GrokEventMapper.js";

function runMapper() {
	const messages: SDKMessage[] = [];
	let sessionId = "pending";
	const mapper = new GrokEventMapper({
		workingDirectory: "/repo",
		model: "grok-4.5",
		getSessionId: () => sessionId,
		emitMessage: (m) => messages.push(m),
		onSessionId: (id) => {
			sessionId = id;
		},
	});
	return { mapper, messages, getSessionId: () => sessionId };
}

function isToolUseAssistant(m: SDKMessage): boolean {
	if (m.type !== "assistant") return false;
	const content = (m as { message?: { content?: unknown } }).message?.content;
	return (
		Array.isArray(content) &&
		content.some(
			(b) =>
				b &&
				typeof b === "object" &&
				(b as { type?: string }).type === "tool_use",
		)
	);
}

function isToolResultUser(m: SDKMessage): boolean {
	if (m.type !== "user") return false;
	const content = (m as { message?: { content?: unknown } }).message?.content;
	return (
		Array.isArray(content) &&
		content.some(
			(b) =>
				b &&
				typeof b === "object" &&
				(b as { type?: string }).type === "tool_result",
		)
	);
}

describe("SDKMessage contract for AgentSessionManager", () => {
	it("emits system/init with session_id and model (stores runner session id)", () => {
		const { mapper, messages, getSessionId } = runMapper();
		mapper.emitInit("sess-abc", "grok-4.5");

		const init = messages.find(
			(m) =>
				m.type === "system" && (m as { subtype?: string }).subtype === "init",
		) as { type: string; subtype: string; session_id: string; model?: string };

		expect(init).toBeDefined();
		expect(init.session_id).toBe("sess-abc");
		expect(init.model).toBe("grok-4.5");
		expect(getSessionId()).toBe("sess-abc");
	});

	it("emits tool_use with id, name, input (Linear action + toolCallsByToolUseId)", () => {
		const { mapper, messages } = runMapper();
		mapper.emitInit("s1");
		mapper.handleUpdate({
			sessionUpdate: "tool_call",
			toolCallId: "call-42",
			rawInput: { target_file: "/repo/a.ts", offset: 1 },
			_meta: { "x.ai/tool": { name: "read_file" } },
		});

		const toolMsg = messages.find(isToolUseAssistant) as {
			message: {
				content: Array<{
					type: string;
					id?: string;
					name?: string;
					input?: Record<string, unknown>;
				}>;
			};
			session_id: string;
		};

		expect(toolMsg).toBeDefined();
		const block = toolMsg.message.content.find((b) => b.type === "tool_use");
		expect(block?.id).toBe("call-42");
		expect(block?.name).toBe("Read");
		expect(block?.input?.file_path).toBe("/repo/a.ts");
		expect(toolMsg.session_id).toBe("s1");
	});

	it("emits tool_result with matching tool_use_id (pairs with tool_use for timeline)", () => {
		const { mapper, messages } = runMapper();
		mapper.emitInit("s1");
		mapper.handleUpdate({
			sessionUpdate: "tool_call",
			toolCallId: "call-42",
			_meta: { "x.ai/tool": { name: "read_file" } },
			rawInput: { target_file: "a.ts" },
		});
		mapper.handleUpdate({
			sessionUpdate: "tool_call_update",
			toolCallId: "call-42",
			status: "completed",
			content: [
				{ type: "content", content: { type: "text", text: "file body" } },
			],
		});

		const resultMsg = messages.find(isToolResultUser) as {
			message: {
				content: Array<{
					type: string;
					tool_use_id?: string;
					content?: string;
					is_error?: boolean;
				}>;
			};
		};
		const block = resultMsg.message.content.find(
			(b) => b.type === "tool_result",
		);
		expect(block?.tool_use_id).toBe("call-42");
		expect(block?.content).toContain("file body");
		expect(block?.is_error).toBe(false);
	});

	it("emits success result with result text for Linear response activity", () => {
		const { mapper, messages } = runMapper();
		mapper.emitInit("s1");
		mapper.handleUpdate({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "Done with the fix." },
		});
		mapper.finalize({ stopReason: "EndTurn" });

		const result = messages.find((m) => m.type === "result") as {
			subtype: string;
			is_error: boolean;
			result?: string;
			session_id: string;
		};
		expect(result.subtype).toBe("success");
		expect(result.is_error).toBe(false);
		expect(result.result).toBe("Done with the fix.");
		expect(result.session_id).toBe("s1");
	});

	it("emits error result with errors[] when turn fails (ASM reads errors)", () => {
		const { mapper, messages } = runMapper();
		mapper.emitInit("s1");
		mapper.finalize({ error: new Error("boom") });

		const result = messages.find((m) => m.type === "result") as {
			is_error: boolean;
			errors?: string[];
		};
		expect(result.is_error).toBe(true);
		expect(result.errors?.join(" ")).toContain("boom");
	});

	/**
	 * Intentional stop (EdgeWorker mid-turn re-prompt, stop signal, etc.).
	 * Codex omits a terminal result when wasStopped; Claude does not treat
	 * AbortError as a failure. Grok must not emit is_error result — ASM posts
	 * those as Linear activity type "error" ("Error from Cyrus").
	 */
	it("does not emit an is_error result when the session was intentionally stopped", () => {
		const { mapper, messages } = runMapper();
		mapper.emitInit("s1");
		mapper.handleUpdate({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "Still working…" },
		});
		// Teardown after stop() rejects in-flight session/prompt with this string.
		mapper.finalize({
			wasStopped: true,
			error: new Error("ACP client closed"),
		});

		const results = messages.filter((m) => m.type === "result");
		const errorResults = results.filter(
			(m) => (m as { is_error?: boolean }).is_error === true,
		);
		expect(errorResults).toEqual([]);
		// No Linear-facing failure body from the stop itself.
		for (const r of results) {
			const errors = (r as { errors?: string[] }).errors;
			if (Array.isArray(errors)) {
				expect(errors.join(" ")).not.toContain("ACP client closed");
			}
		}
	});

	it("still emits is_error when ACP closes without an intentional stop", () => {
		const { mapper, messages } = runMapper();
		mapper.emitInit("s1");
		mapper.finalize({ error: new Error("ACP client closed") });

		const result = messages.find((m) => m.type === "result") as {
			is_error: boolean;
			errors?: string[];
		};
		expect(result?.is_error).toBe(true);
		expect(result?.errors?.join(" ")).toContain("ACP client closed");
	});

	it("full ACP-like turn order: init → tool_use → tool_result → text → result", () => {
		const { mapper, messages } = runMapper();
		mapper.emitInit("s1", "grok-4.5");
		mapper.handleUpdate({
			sessionUpdate: "tool_call",
			toolCallId: "c1",
			_meta: { "x.ai/tool": { name: "run_terminal_command" } },
			rawInput: { command: "ls", description: "list" },
		});
		mapper.handleUpdate({
			sessionUpdate: "tool_call_update",
			toolCallId: "c1",
			status: "in_progress",
		});
		mapper.handleUpdate({
			sessionUpdate: "tool_call_update",
			toolCallId: "c1",
			status: "completed",
			content: [{ type: "content", content: { type: "text", text: "a.ts\n" } }],
		});
		mapper.handleUpdate({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "Listed files." },
		});
		mapper.finalize({ stopReason: "end_turn" });

		const sequence = messages.map((m) => {
			if (m.type === "system") return "init";
			if (isToolUseAssistant(m)) return "tool_use";
			if (isToolResultUser(m)) return "tool_result";
			if (m.type === "assistant") return "text";
			if (m.type === "result") return "result";
			return m.type;
		});

		expect(sequence).toEqual([
			"init",
			"tool_use",
			"tool_result",
			"text",
			"result",
		]);
	});
});
