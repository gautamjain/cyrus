/**
 * Minimal ACP / Grok agent protocol types used by the runner.
 * Not exhaustive — only fields Cyrus needs for lifecycle + activity mapping.
 */

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
	jsonrpc: "2.0";
	id: JsonRpcId;
	method: string;
	params?: unknown;
}

export interface JsonRpcResponse {
	jsonrpc: "2.0";
	id: JsonRpcId;
	result?: unknown;
	error?: { code?: number; message?: string; data?: unknown };
}

export interface JsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export type JsonRpcMessage = JsonRpcResponse | JsonRpcNotification;

export interface AcpAuthMethod {
	id: string;
	name?: string;
	description?: string;
}

export interface AcpMcpCapabilities {
	http?: boolean;
	sse?: boolean;
}

export interface AcpSessionCapabilities {
	resume?: Record<string, unknown> | boolean;
	close?: Record<string, unknown> | boolean;
	additionalDirectories?: Record<string, unknown> | boolean;
}

export interface AcpAgentCapabilities {
	loadSession?: boolean;
	sessionCapabilities?: AcpSessionCapabilities;
	mcpCapabilities?: AcpMcpCapabilities;
	[key: string]: unknown;
}

export interface AcpInitializeResult {
	protocolVersion?: number;
	authMethods?: AcpAuthMethod[];
	agentCapabilities?: AcpAgentCapabilities;
	agentInfo?: { name?: string; version?: string };
}

export interface AcpAuthenticateResult {
	_meta?: {
		email?: string;
		auth_mode?: string;
		subscription_tier?: string;
		team_id?: string;
		[key: string]: unknown;
	};
}

export interface AcpSessionNewResult {
	sessionId?: string | null;
	models?: {
		currentModelId?: string;
		availableModels?: Array<{
			modelId: string;
			name?: string;
			description?: string;
		}>;
	};
	_meta?: Record<string, unknown>;
}

export interface AcpSessionPromptResult {
	stopReason?: string;
	_meta?: Record<string, unknown>;
}

export type AcpSessionUpdateType =
	| "agent_message_chunk"
	| "agent_thought_chunk"
	| "user_message_chunk"
	| "tool_call"
	| "tool_call_update"
	| "plan"
	| "current_mode_update"
	| "available_commands_update"
	| string;

export interface AcpToolMeta {
	version?: number;
	name?: string;
	kind?: string;
	namespace?: string;
	label?: string;
	read_only?: boolean;
	input?: Record<string, unknown>;
}

export interface AcpAvailableCommand {
	name?: string;
	description?: string;
	input?: { hint?: string } | null;
}

export interface AcpSessionUpdate {
	sessionUpdate: AcpSessionUpdateType;
	content?: { type?: string; text?: string } | unknown;
	toolCallId?: string;
	title?: string;
	kind?: string;
	status?: string | null;
	rawInput?: Record<string, unknown>;
	rawOutput?: unknown;
	locations?: Array<{ path?: string }>;
	/** Slash commands / skills (available_commands_update). */
	availableCommands?: AcpAvailableCommand[];
	_meta?: {
		"x.ai/tool"?: AcpToolMeta;
		/** Live built-in (+ MCP) tool names on available_commands_update. */
		tools?: string[];
		[key: string]: unknown;
	};
}

export interface AcpSessionUpdateParams {
	sessionId?: string;
	update?: AcpSessionUpdate;
}

/** ACP EnvVariable: [{ name, value }] */
export interface AcpNameValue {
	name: string;
	value: string;
}

/** stdio MCP server for ACP session/new */
export interface AcpMcpStdioServer {
	name: string;
	command: string;
	/** Required by ACP (may be empty) */
	args: string[];
	env?: AcpNameValue[];
}

/** HTTP/SSE MCP server for ACP session/new */
export interface AcpMcpHttpServer {
	name: string;
	type: "http" | "sse";
	url: string;
	/** Required by ACP for http/sse */
	headers: AcpNameValue[];
}

export type AcpMcpServer = AcpMcpStdioServer | AcpMcpHttpServer;
