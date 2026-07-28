import crypto from "node:crypto";
import { cwd } from "node:process";
import type {
	SDKAssistantMessage,
	SDKMessage,
	SDKResultMessage,
	SDKUserMessage,
} from "cyrus-core";
import type { AcpSessionUpdate } from "./backend/acpTypes.js";

export type MapperContext = {
	workingDirectory?: string;
	model?: string;
	getSessionId(): string;
	emitMessage(message: SDKMessage): void;
	onSessionId(sessionId: string): void;
};

type ToolInput = Record<string, unknown>;

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function emptyUsageBlock(): SDKAssistantMessage["message"]["usage"] {
	return {
		input_tokens: 0,
		output_tokens: 0,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
		output_tokens_details: null,
		cache_creation: null,
		inference_geo: null,
		iterations: null,
		server_tool_use: null,
		service_tier: null,
		speed: null,
	};
}

function createResultUsage(): SDKResultMessage["usage"] {
	return {
		input_tokens: 0,
		output_tokens: 0,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 0,
		output_tokens_details: { thinking_tokens: 0 },
		cache_creation: {
			ephemeral_1h_input_tokens: 0,
			ephemeral_5m_input_tokens: 0,
		},
		inference_geo: "unknown",
		iterations: [],
		server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
		service_tier: "standard",
		speed: "standard",
	} as SDKResultMessage["usage"];
}

function createAssistantToolUseMessage(
	toolUseId: string,
	toolName: string,
	toolInput: ToolInput,
	model: string,
	messageId: string = crypto.randomUUID(),
): SDKAssistantMessage["message"] {
	const contentBlocks = [
		{ type: "tool_use", id: toolUseId, name: toolName, input: toolInput },
	] as unknown as SDKAssistantMessage["message"]["content"];

	return {
		id: messageId,
		type: "message",
		role: "assistant",
		content: contentBlocks,
		model: model as SDKAssistantMessage["message"]["model"],
		stop_reason: null,
		stop_sequence: null,
		stop_details: null,
		usage: emptyUsageBlock(),
		container: null,
		context_management: null,
		diagnostics: null,
	};
}

function createUserToolResultMessage(
	toolUseId: string,
	result: string,
	isError: boolean,
): SDKUserMessage["message"] {
	const contentBlocks = [
		{
			type: "tool_result",
			tool_use_id: toolUseId,
			content: result,
			is_error: isError,
		},
	] as unknown as SDKUserMessage["message"]["content"];

	return { role: "user", content: contentBlocks };
}

function createAssistantTextMessage(
	content: string,
	model: string,
	messageId: string = crypto.randomUUID(),
): SDKAssistantMessage["message"] {
	const contentBlocks = [
		{ type: "text", text: content },
	] as unknown as SDKAssistantMessage["message"]["content"];

	return {
		id: messageId,
		type: "message",
		role: "assistant",
		content: contentBlocks,
		model: model as SDKAssistantMessage["message"]["model"],
		stop_reason: null,
		stop_sequence: null,
		stop_details: null,
		usage: emptyUsageBlock(),
		container: null,
		context_management: null,
		diagnostics: null,
	};
}

/**
 * Project Grok built-in tool names to Claude-ish names for Linear formatters.
 */
export function projectGrokToolName(rawName: string): string {
	const name = rawName.toLowerCase();
	switch (name) {
		case "run_terminal_command":
		case "run_terminal_cmd":
			return "Bash";
		case "read_file":
			return "Read";
		case "list_dir":
		case "list_directory":
			return "Glob";
		case "grep":
			return "Grep";
		case "search_replace":
			return "Edit";
		case "write":
		case "write_file":
			return "Write";
		case "web_search":
			return "WebSearch";
		case "web_fetch":
			return "WebFetch";
		case "todo_write":
			return "TodoWrite";
		default:
			// MCP tools often arrive as server__tool
			if (rawName.includes("__")) {
				const [server, ...rest] = rawName.split("__");
				return `mcp__${server}__${rest.join("__")}`;
			}
			return rawName;
	}
}

function projectToolInput(
	toolName: string,
	rawInput: Record<string, unknown> | undefined,
): ToolInput {
	const input = { ...(rawInput || {}) };

	// Normalize common Grok field names to Claude-style for formatters.
	if (toolName === "Bash" || toolName === "run_terminal_command") {
		return {
			command:
				typeof input.command === "string"
					? input.command
					: typeof input.cmd === "string"
						? input.cmd
						: "",
			description:
				typeof input.description === "string" ? input.description : undefined,
		};
	}
	if (toolName === "Read" || toolName === "read_file") {
		const path =
			typeof input.target_file === "string"
				? input.target_file
				: typeof input.path === "string"
					? input.path
					: typeof input.file_path === "string"
						? input.file_path
						: "";
		return {
			file_path: path,
			offset: input.offset,
			limit: input.limit,
		};
	}
	if (toolName === "Grep" || toolName === "grep") {
		return {
			pattern: typeof input.pattern === "string" ? input.pattern : "",
			path:
				typeof input.path === "string"
					? input.path
					: typeof input.glob === "string"
						? input.glob
						: undefined,
		};
	}
	if (toolName === "Edit" || toolName === "search_replace") {
		const path =
			typeof input.file_path === "string"
				? input.file_path
				: typeof input.path === "string"
					? input.path
					: "";
		return { file_path: path, ...input };
	}
	if (toolName === "Glob" || toolName === "list_dir") {
		return {
			path:
				typeof input.target_directory === "string"
					? input.target_directory
					: typeof input.path === "string"
						? input.path
						: "",
			pattern: typeof input.pattern === "string" ? input.pattern : undefined,
		};
	}

	return input;
}

function extractToolResultText(update: AcpSessionUpdate): {
	text: string;
	isError: boolean;
} {
	const status = (update.status || "").toString().toLowerCase();
	// Mirror Codex/Cursor: non-success terminal statuses are errors for the timeline.
	// ACP often uses failed; cancelled is turn-abort (Cursor maps CANCELLED similarly).
	const isCancelled = status === "cancelled" || status === "canceled";
	const isError = status === "error" || status === "failed" || isCancelled;

	if (Array.isArray(update.content)) {
		const parts: string[] = [];
		for (const block of update.content) {
			if (!block || typeof block !== "object") continue;
			const b = block as Record<string, unknown>;
			const inner = b.content;
			if (inner && typeof inner === "object") {
				const text = (inner as { text?: string }).text;
				if (typeof text === "string") parts.push(text);
			} else if (typeof b.text === "string") {
				parts.push(b.text);
			}
		}
		if (parts.length > 0) {
			return { text: parts.join("\n"), isError };
		}
	}

	if (update.rawOutput !== undefined && update.rawOutput !== null) {
		if (typeof update.rawOutput === "string") {
			return { text: update.rawOutput, isError };
		}
		const rec = update.rawOutput as Record<string, unknown>;
		// Common Grok shapes
		const fileContent = rec.FileContent as Record<string, unknown> | undefined;
		if (fileContent) {
			const raw =
				typeof fileContent.raw_output === "string"
					? fileContent.raw_output
					: typeof fileContent.content === "string"
						? fileContent.content
						: safeStringify(fileContent);
			return { text: raw, isError };
		}
		if (typeof rec.output_for_prompt === "string") {
			return { text: rec.output_for_prompt, isError };
		}
		return { text: safeStringify(update.rawOutput), isError };
	}

	return {
		text: isCancelled
			? "Tool cancelled"
			: isError
				? "Tool failed"
				: "Tool completed",
		isError,
	};
}

/**
 * Translates Grok ACP `session/update` notifications into Claude-shaped
 * SDKMessages for AgentSessionManager / Linear activities.
 */
export class GrokEventMapper {
	private messages: SDKMessage[] = [];
	private hasInitMessage = false;
	private assistantTextBuffer = "";
	private lastAssistantText: string | null = null;
	private emittedToolUseIds = new Set<string>();
	/** Dedupe terminal tool_call_update → tool_result (ACP may send multiple). */
	private emittedToolResultIds = new Set<string>();
	private startTimestampMs = 0;
	private errorMessages: string[] = [];
	private model: string;
	/**
	 * When true, handleUpdate is a no-op. Used during session/load replay so
	 * historical tool/assistant events are not re-posted to Linear.
	 */
	private suppressUpdates = false;

	constructor(private readonly ctx: MapperContext) {
		this.model = ctx.model || "grok-4.5";
		this.startTimestampMs = Date.now();
	}

	reset(): void {
		this.messages = [];
		this.hasInitMessage = false;
		this.assistantTextBuffer = "";
		this.lastAssistantText = null;
		this.emittedToolUseIds.clear();
		this.emittedToolResultIds.clear();
		this.startTimestampMs = Date.now();
		this.errorMessages = [];
		this.suppressUpdates = false;
	}

	setSuppressUpdates(suppress: boolean): void {
		this.suppressUpdates = suppress;
		if (suppress) {
			// Drop any partial text accumulated during replay.
			this.assistantTextBuffer = "";
		}
	}

	getMessages(): SDKMessage[] {
		return [...this.messages];
	}

	setModel(model: string): void {
		if (model) this.model = model;
	}

	emitInit(sessionId: string, model?: string): void {
		if (this.hasInitMessage) return;
		if (model) this.model = model;
		this.ctx.onSessionId(sessionId);

		const initMessage = {
			type: "system" as const,
			subtype: "init" as const,
			agents: undefined,
			apiKeySource: "user" as const,
			claude_code_version: "grok-adapter",
			cwd: this.ctx.workingDirectory || cwd(),
			tools: [] as string[],
			mcp_servers: [] as Array<{ name: string; status: string }>,
			model: this.model,
			permissionMode: "default" as const,
			slash_commands: [] as string[],
			output_style: "default",
			skills: [] as string[],
			plugins: [] as Array<{ name: string; path: string }>,
			uuid: crypto.randomUUID(),
			session_id: sessionId,
		} as SDKMessage;

		this.hasInitMessage = true;
		this.push(initMessage);
	}

	handleUpdate(update: AcpSessionUpdate): void {
		if (this.suppressUpdates) {
			return;
		}

		const kind = update.sessionUpdate;

		if (kind === "agent_message_chunk") {
			const text = extractChunkText(update);
			if (text) {
				this.assistantTextBuffer += text;
			}
			return;
		}

		if (kind === "agent_thought_chunk") {
			// Thoughts are not posted as assistant responses; ignore for Linear body.
			return;
		}

		if (kind === "tool_call") {
			this.flushAssistantText();
			this.emitToolUse(update);
			return;
		}

		if (kind === "tool_call_update") {
			const status = (update.status || "").toString().toLowerCase();
			// Emit tool_use on first sight if we missed the pending tool_call
			if (update.toolCallId && !this.emittedToolUseIds.has(update.toolCallId)) {
				this.emitToolUse(update);
			}
			if (
				status === "completed" ||
				status === "error" ||
				status === "failed" ||
				status === "cancelled"
			) {
				this.emitToolResult(update);
			}
			return;
		}
	}

	/**
	 * Finalize the turn after session/prompt resolves (or on stop/error).
	 */
	finalize(options?: {
		error?: unknown;
		stopReason?: string;
		wasStopped?: boolean;
		/**
		 * Tools refused by the client's policy during this session. Reported on
		 * the result message so a caller can tell "the agent chose not to" apart
		 * from "the agent was not allowed to" — previously indistinguishable,
		 * since this field was hard-coded empty even when a write was blocked.
		 */
		permissionDenials?: Array<{ tool: string; reason: string }>;
	}): void {
		this.suppressUpdates = false;
		this.flushAssistantText();

		const durationMs = Date.now() - this.startTimestampMs;

		const permissionDenials = (options?.permissionDenials ?? []).map(
			(denial) => ({
				tool_name: denial.tool,
				tool_use_id: null,
				tool_input: {},
				reason: denial.reason,
			}),
		);
		const sessionId = this.ctx.getSessionId();

		if (options?.error || options?.wasStopped) {
			const message =
				options.error instanceof Error
					? options.error.message
					: options?.wasStopped
						? "Session stopped"
						: String(options?.error || "Grok session failed");
			this.errorMessages.push(message);

			const result = {
				type: "result" as const,
				subtype: "error_during_execution" as const,
				duration_ms: durationMs,
				duration_api_ms: durationMs,
				is_error: true as const,
				num_turns: 1,
				stop_reason: null,
				errors: this.errorMessages,
				total_cost_usd: 0,
				usage: createResultUsage(),
				modelUsage: {},
				permission_denials: permissionDenials,
				uuid: crypto.randomUUID(),
				session_id: sessionId,
			} as unknown as SDKResultMessage;
			this.push(result);
			return;
		}

		const resultText =
			this.lastAssistantText ||
			(options?.stopReason ? `Stopped: ${options.stopReason}` : "");

		const result = {
			type: "result" as const,
			subtype: "success" as const,
			duration_ms: durationMs,
			duration_api_ms: durationMs,
			is_error: false as const,
			num_turns: 1,
			result: resultText,
			stop_reason: null,
			total_cost_usd: 0,
			usage: createResultUsage(),
			modelUsage: {},
			permission_denials: permissionDenials,
			uuid: crypto.randomUUID(),
			session_id: sessionId,
		} as unknown as SDKResultMessage;
		this.push(result);
	}

	private flushAssistantText(): void {
		const text = this.assistantTextBuffer.trim();
		this.assistantTextBuffer = "";
		if (!text) return;

		this.lastAssistantText = text;
		const assistant: SDKAssistantMessage = {
			type: "assistant",
			message: createAssistantTextMessage(text, this.model),
			parent_tool_use_id: null,
			uuid: crypto.randomUUID(),
			session_id: this.ctx.getSessionId(),
		};
		this.push(assistant);
	}

	private emitToolUse(update: AcpSessionUpdate): void {
		const toolCallId = update.toolCallId;
		if (!toolCallId || this.emittedToolUseIds.has(toolCallId)) return;

		// Prefer structured tool id; title is human-readable UI text.
		const metaName = update._meta?.["x.ai/tool"]?.name;
		const rawName =
			metaName ||
			// Only use title if it looks like a tool id (snake_case), not a sentence
			(update.title && /^[a-zA-Z][\w.-]*$/.test(update.title)
				? update.title
				: "Tool");
		const toolName = projectGrokToolName(rawName);
		const toolInput = projectToolInput(
			toolName,
			update.rawInput || update._meta?.["x.ai/tool"]?.input,
		);

		this.emittedToolUseIds.add(toolCallId);

		const assistant: SDKAssistantMessage = {
			type: "assistant",
			message: createAssistantToolUseMessage(
				toolCallId,
				toolName,
				toolInput,
				this.model,
			),
			parent_tool_use_id: null,
			uuid: crypto.randomUUID(),
			session_id: this.ctx.getSessionId(),
		};
		this.push(assistant);
	}

	private emitToolResult(update: AcpSessionUpdate): void {
		const toolCallId = update.toolCallId;
		if (!toolCallId || this.emittedToolResultIds.has(toolCallId)) return;
		this.emittedToolResultIds.add(toolCallId);

		const { text, isError } = extractToolResultText(update);
		const user: SDKUserMessage = {
			type: "user",
			message: createUserToolResultMessage(toolCallId, text, isError),
			parent_tool_use_id: null,
			uuid: crypto.randomUUID(),
			session_id: this.ctx.getSessionId(),
		} as SDKUserMessage;
		this.push(user);
	}

	private push(message: SDKMessage): void {
		this.messages.push(message);
		this.ctx.emitMessage(message);
	}
}

function extractChunkText(update: AcpSessionUpdate): string {
	const content = update.content;
	if (!content) return "";
	if (typeof content === "string") return content;
	if (typeof content === "object" && content !== null) {
		const c = content as { text?: string; type?: string };
		if (typeof c.text === "string") return c.text;
	}
	return "";
}
