import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerConfig } from "cyrus-core";
import dotenv from "dotenv";
import type {
	AcpMcpCapabilities,
	AcpMcpServer,
	AcpNameValue,
} from "./acpTypes.js";

function recordToNameValueList(
	record: Record<string, string> | undefined,
): AcpNameValue[] {
	if (!record) return [];
	return Object.entries(record).map(([name, value]) => ({
		name,
		value: String(value),
	}));
}

/**
 * Expand `${VAR}` and `${VAR:-default}` using an env map.
 * Unknown vars without a default become empty string (same family as shell
 * optional-default forms used in MCP configs).
 */
export function expandEnvInString(
	value: string,
	env: Record<string, string | undefined> = process.env,
): string {
	return value.replace(
		/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
		(_match, name: string, defaultValue: string | undefined) => {
			const v = env[name];
			if (v !== undefined && v !== "") return v;
			if (defaultValue !== undefined) return defaultValue;
			return v ?? "";
		},
	);
}

function expandRecordValues(
	record: Record<string, string> | undefined,
	env: Record<string, string | undefined>,
): Record<string, string> | undefined {
	if (!record) return undefined;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(record)) {
		out[k] = expandEnvInString(String(v), env);
	}
	return out;
}

/**
 * Parse a dotenv-style file into key/value pairs.
 * Does not override keys already present in `base`.
 */
export function loadDotEnvFile(
	filePath: string,
	base: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
	const out: Record<string, string | undefined> = { ...base };
	if (!existsSync(filePath)) return out;
	try {
		const parsed = dotenv.parse(readFileSync(filePath, "utf8"));
		for (const [key, val] of Object.entries(parsed)) {
			if (out[key] === undefined || out[key] === "") {
				out[key] = val;
			}
		}
	} catch {
		// ignore unreadable .env
	}
	return out;
}

/**
 * Build the env map used for MCP string expansion: process.env, then
 * fill gaps from `<workingDirectory>/.env`.
 */
export function buildMcpExpandEnv(
	workingDirectory?: string,
): Record<string, string | undefined> {
	let env: Record<string, string | undefined> = { ...process.env };
	if (workingDirectory) {
		env = loadDotEnvFile(join(workingDirectory, ".env"), env);
	}
	return env;
}

/**
 * Auto-detect `.mcp.json` in the session working directory.
 * Same order/shape as Claude, Codex, and Gemini runners.
 */
export function autoDetectMcpConfigPath(
	workingDirectory?: string,
): string | undefined {
	if (!workingDirectory) {
		return undefined;
	}

	const mcpPath = join(workingDirectory, ".mcp.json");
	if (!existsSync(mcpPath)) {
		return undefined;
	}

	try {
		JSON.parse(readFileSync(mcpPath, "utf8"));
		return mcpPath;
	} catch {
		console.warn(
			`[GrokRunner] Found .mcp.json at ${mcpPath} but it is invalid JSON, skipping`,
		);
		return undefined;
	}
}

/**
 * Collect MCP config file paths (Claude/Codex/Gemini order):
 * 1. Auto-detected worktree `.mcp.json`
 * 2. Explicit `mcpConfigPath` entries from EdgeWorker (as-is)
 */
export function collectMcpConfigPaths(
	mcpConfigPath: string | string[] | undefined,
	workingDirectory?: string,
): string[] {
	const paths: string[] = [];
	const auto = autoDetectMcpConfigPath(workingDirectory);
	if (auto) {
		paths.push(auto);
	}
	if (mcpConfigPath) {
		const explicit = Array.isArray(mcpConfigPath)
			? mcpConfigPath
			: [mcpConfigPath];
		paths.push(...explicit);
	}
	return paths;
}

export function loadMcpConfigFromPaths(
	configPaths: string | string[] | undefined,
): Record<string, McpServerConfig> {
	if (!configPaths) return {};

	const paths = Array.isArray(configPaths) ? configPaths : [configPaths];
	let mcpServers: Record<string, McpServerConfig> = {};

	for (const configPath of paths) {
		try {
			const content = readFileSync(configPath, "utf8");
			const parsed = JSON.parse(content) as {
				mcpServers?: Record<string, McpServerConfig>;
			};
			const servers =
				parsed?.mcpServers && typeof parsed.mcpServers === "object"
					? parsed.mcpServers
					: {};
			mcpServers = { ...mcpServers, ...servers };
			console.log(
				`[GrokRunner] Loaded MCP config from ${configPath}: ${Object.keys(servers).join(", ") || "(none)"}`,
			);
		} catch (error) {
			console.warn(
				`[GrokRunner] Failed to load MCP config from ${configPath}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}

	return mcpServers;
}

export interface McpTranslateOptions {
	workingDirectory?: string;
	mcpConfigPath?: string | string[];
	mcpConfig?: Record<string, McpServerConfig>;
	/** From initialize agentCapabilities.mcpCapabilities */
	mcpCapabilities?: AcpMcpCapabilities;
	/**
	 * Env map for `${VAR}` expansion. Defaults to process.env plus
	 * `<workingDirectory>/.env` gap-fill when workingDirectory is set.
	 * (Grok ACP needs expanded headers/env; Claude/Codex expand differently.)
	 */
	env?: Record<string, string | undefined>;
}

/**
 * Build ACP mcpServers list from Cyrus config (paths + inline).
 * Wire shape matches ACP:
 * - env: [{ name, value }]
 * - headers: [{ name, value }]
 * - args: string[] (required for stdio)
 */
export function translateMcpConfigToAcp(
	options: McpTranslateOptions | Record<string, McpServerConfig> | undefined,
): AcpMcpServer[] {
	// Back-compat: old call site passed raw mcpConfig record
	const opts: McpTranslateOptions =
		options &&
		typeof options === "object" &&
		("mcpConfig" in options ||
			"mcpConfigPath" in options ||
			"workingDirectory" in options ||
			"mcpCapabilities" in options ||
			"env" in options)
			? (options as McpTranslateOptions)
			: { mcpConfig: options as Record<string, McpServerConfig> | undefined };

	const expandEnv = opts.env ?? buildMcpExpandEnv(opts.workingDirectory);

	const configPaths = collectMcpConfigPaths(
		opts.mcpConfigPath,
		opts.workingDirectory,
	);
	const pathConfigs = loadMcpConfigFromPaths(
		configPaths.length > 0 ? configPaths : undefined,
	);

	// Inline overrides paths (natives win on name clash)
	const merged: Record<string, McpServerConfig> = {
		...pathConfigs,
		...(opts.mcpConfig || {}),
	};

	// ACP: HTTP/SSE only when the agent advertises them (false or absent = unsupported).
	// Stdio is always allowed. Match both transports with the same opt-in rule.
	const httpSupported = opts.mcpCapabilities?.http === true;
	const sseSupported = opts.mcpCapabilities?.sse === true;

	const servers: AcpMcpServer[] = [];

	for (const [name, raw] of Object.entries(merged)) {
		const cfg = raw as Record<string, unknown>;

		if (
			typeof cfg.listTools === "function" ||
			typeof cfg.callTool === "function"
		) {
			console.warn(
				`[GrokRunner] Skipping MCP server '${name}': in-process SDK servers cannot be passed to Grok ACP`,
			);
			continue;
		}

		if (typeof cfg.url === "string" && cfg.url.length > 0) {
			const type = cfg.type === "sse" ? "sse" : "http";
			if (type === "http" && !httpSupported) {
				console.warn(
					`[GrokRunner] Skipping MCP server '${name}': agent does not advertise mcpCapabilities.http`,
				);
				continue;
			}
			if (type === "sse" && !sseSupported) {
				console.warn(
					`[GrokRunner] Skipping MCP server '${name}': agent does not advertise mcpCapabilities.sse`,
				);
				continue;
			}

			const headersRecord =
				cfg.headers &&
				typeof cfg.headers === "object" &&
				!Array.isArray(cfg.headers)
					? (cfg.headers as Record<string, string>)
					: undefined;

			servers.push({
				name,
				type,
				url: expandEnvInString(cfg.url, expandEnv),
				headers: recordToNameValueList(
					expandRecordValues(headersRecord, expandEnv),
				),
			});
			continue;
		}

		if (typeof cfg.command === "string" && cfg.command.length > 0) {
			const args = Array.isArray(cfg.args)
				? (cfg.args as unknown[]).map((a) =>
						expandEnvInString(String(a), expandEnv),
					)
				: [];
			const envRecord =
				cfg.env && typeof cfg.env === "object" && !Array.isArray(cfg.env)
					? (cfg.env as Record<string, string>)
					: undefined;
			servers.push({
				name,
				command: expandEnvInString(cfg.command, expandEnv),
				args,
				env: recordToNameValueList(expandRecordValues(envRecord, expandEnv)),
			});
			continue;
		}

		console.warn(
			`[GrokRunner] Skipping MCP server '${name}': no serializable command/url transport`,
		);
	}

	return servers;
}

/** Test helper: convert a plain record to ACP name/value list */
export function toAcpNameValueList(
	record: Record<string, string> | undefined,
): AcpNameValue[] {
	return recordToNameValueList(record);
}
