import { type ChildProcess, spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline";
import type {
	JsonRpcId,
	JsonRpcMessage,
	JsonRpcNotification,
	JsonRpcRequest,
	JsonRpcResponse,
} from "./acpTypes.js";

type Pending = {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	/** Absolute wall-clock timer (optional). */
	wallTimer?: ReturnType<typeof setTimeout>;
	/** Idle timer; re-armed by {@link AcpClient.touchActivity}. */
	idleTimer?: ReturnType<typeof setTimeout>;
	/** Idle timeout duration; present when idle watchdog is active. */
	idleTimeoutMs?: number;
	method: string;
};

/**
 * Per-request timeout options.
 *
 * - `timeoutMs`: absolute wall-clock. `0` disables. `undefined` uses client default.
 * - `idleTimeoutMs`: fail only after this much silence (no agent messages).
 *   Resets on every notification / agent→client request. `0` disables.
 *   Codex uses the same pattern for turn execution (activity-based, not wall-clock).
 */
export type AcpRequestTimeoutOptions = {
	timeoutMs?: number;
	idleTimeoutMs?: number;
};

export type AcpClientOptions = {
	command: string;
	args: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	/**
	 * Default wall-clock timeout for control-plane requests (initialize, auth,
	 * session/new, session/load, …). `0` disables. Defaults to 120s when unset.
	 */
	requestTimeoutMs?: number;
	onNotification?: (notification: JsonRpcNotification) => void;
	/**
	 * Handle agent → client JSON-RPC requests (messages with both `id` and `method`).
	 * Return a result object, or throw / return null to send a method-not-found error.
	 * Default: auto-approve `session/request_permission`, reject everything else.
	 */
	onAgentRequest?: (
		method: string,
		params: unknown,
	) => Promise<unknown> | unknown;
	onStderr?: (chunk: string) => void;
	onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
};

/**
 * Minimal JSON-RPC 2.0 client over a child process stdio (one JSON object per line).
 *
 * Important: ACP is bidirectional. The agent may send *requests* to the client
 * (e.g. `session/request_permission`) with both `id` and `method`. Those must
 * not be treated as responses to our pending calls.
 *
 * Timeouts:
 * - Control-plane RPCs use a wall-clock timeout so a wedged child cannot hang forever.
 * - Long agent turns (`session/prompt`) should use `idleTimeoutMs` instead: any
 *   agent traffic (session/update notifications, reverse RPCs) resets the idle
 *   timer, matching Codex's turn idle watchdog. Productive multi-hour turns stay
 *   alive; true silence still fails the pending request.
 */
export class AcpClient {
	private proc: ChildProcess | null = null;
	private readline: Interface | null = null;
	private nextId = 1;
	private pending = new Map<JsonRpcId, Pending>();
	private closed = false;
	private readonly options: AcpClientOptions;

	constructor(options: AcpClientOptions) {
		this.options = options;
	}

	start(): void {
		if (this.proc) {
			throw new Error("AcpClient already started");
		}

		this.proc = spawn(this.options.command, this.options.args, {
			cwd: this.options.cwd,
			env: this.options.env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		this.proc.on("error", (err) => {
			this.failAll(err);
		});

		this.proc.on("exit", (code, signal) => {
			this.closed = true;
			this.failAll(
				new Error(
					`Grok ACP process exited (code=${code}, signal=${signal ?? "none"})`,
				),
			);
			this.options.onExit?.(code, signal);
		});

		if (this.proc.stderr) {
			this.proc.stderr.setEncoding("utf8");
			this.proc.stderr.on("data", (chunk: string) => {
				this.options.onStderr?.(chunk);
			});
		}

		if (!this.proc.stdout) {
			throw new Error("Grok ACP process has no stdout");
		}

		this.readline = createInterface({
			input: this.proc.stdout,
			crlfDelay: Number.POSITIVE_INFINITY,
		});

		this.readline.on("line", (line) => {
			const trimmed = line.trim();
			if (!trimmed) return;
			let msg: JsonRpcMessage;
			try {
				msg = JSON.parse(trimmed) as JsonRpcMessage;
			} catch {
				console.warn(
					`[AcpClient] Ignoring non-JSON stdout line: ${trimmed.slice(0, 200)}`,
				);
				return;
			}
			void this.handleMessage(msg);
		});
	}

	/**
	 * Send a JSON-RPC request.
	 *
	 * Third argument may be a number (legacy wall-clock ms) or
	 * {@link AcpRequestTimeoutOptions}.
	 */
	async request(
		method: string,
		params?: unknown,
		timeoutOrOptions?: number | AcpRequestTimeoutOptions,
	): Promise<unknown> {
		if (!this.proc?.stdin || this.closed) {
			throw new Error(`Cannot send ACP request ${method}: process not running`);
		}

		const opts = normalizeTimeoutOptions(
			timeoutOrOptions,
			this.options.requestTimeoutMs,
		);

		const id = this.nextId++;
		const request: JsonRpcRequest = {
			jsonrpc: "2.0",
			id,
			method,
			...(params !== undefined ? { params } : {}),
		};

		return new Promise((resolve, reject) => {
			const pending: Pending = {
				resolve,
				reject,
				method,
			};

			if (opts.timeoutMs > 0) {
				pending.wallTimer = setTimeout(() => {
					this.rejectPending(id, new Error(`ACP request timed out: ${method}`));
				}, opts.timeoutMs);
				pending.wallTimer.unref?.();
			}

			if (opts.idleTimeoutMs > 0) {
				pending.idleTimeoutMs = opts.idleTimeoutMs;
				pending.idleTimer = this.createIdleTimer(
					id,
					method,
					opts.idleTimeoutMs,
				);
			}

			this.pending.set(id, pending);

			const payload = `${JSON.stringify(request)}\n`;
			this.proc?.stdin?.write(payload, (err) => {
				if (err) {
					this.rejectPending(
						id,
						err instanceof Error ? err : new Error(String(err)),
					);
				}
			});
		});
	}

	/**
	 * Reset idle watchdogs on all pending requests that use idle timeouts.
	 * Called when the agent produces any traffic (notifications / reverse RPC).
	 */
	touchActivity(): void {
		for (const [id, pending] of this.pending) {
			if (!pending.idleTimeoutMs || pending.idleTimeoutMs <= 0) {
				continue;
			}
			if (pending.idleTimer) {
				clearTimeout(pending.idleTimer);
			}
			pending.idleTimer = this.createIdleTimer(
				id,
				pending.method,
				pending.idleTimeoutMs,
			);
		}
	}

	/**
	 * Send a JSON-RPC response to an agent-initiated request.
	 * Write errors are logged (same class of issue as request() write failures);
	 * process exit / failAll covers the usual dead-child case.
	 */
	respond(id: JsonRpcId, result: unknown): void {
		if (!this.proc?.stdin || this.closed) return;
		const payload = `${JSON.stringify({
			jsonrpc: "2.0",
			id,
			result,
		})}\n`;
		this.proc.stdin.write(payload, (err) => {
			if (err) {
				console.warn(
					`[AcpClient] Failed to write response for id=${id}: ${err.message}`,
				);
			}
		});
	}

	respondError(
		id: JsonRpcId,
		code: number,
		message: string,
		data?: unknown,
	): void {
		if (!this.proc?.stdin || this.closed) return;
		const payload = `${JSON.stringify({
			jsonrpc: "2.0",
			id,
			error: { code, message, ...(data !== undefined ? { data } : {}) },
		})}\n`;
		this.proc.stdin.write(payload, (err) => {
			if (err) {
				console.warn(
					`[AcpClient] Failed to write error response for id=${id}: ${err.message}`,
				);
			}
		});
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): void {
		if (this.proc && !this.closed) {
			this.proc.kill(signal);
		}
		this.cleanup();
	}

	isRunning(): boolean {
		return Boolean(this.proc && !this.closed);
	}

	private createIdleTimer(
		id: JsonRpcId,
		method: string,
		idleTimeoutMs: number,
	): ReturnType<typeof setTimeout> {
		const timer = setTimeout(() => {
			this.rejectPending(
				id,
				new Error(
					`ACP request idle timeout: ${method} (no activity for ${idleTimeoutMs}ms)`,
				),
			);
		}, idleTimeoutMs);
		timer.unref?.();
		return timer;
	}

	private rejectPending(id: JsonRpcId, error: Error): void {
		const pending = this.pending.get(id);
		if (!pending) {
			return;
		}
		this.clearPendingTimers(pending);
		this.pending.delete(id);
		pending.reject(error);
	}

	private clearPendingTimers(pending: Pending): void {
		if (pending.wallTimer) {
			clearTimeout(pending.wallTimer);
			pending.wallTimer = undefined;
		}
		if (pending.idleTimer) {
			clearTimeout(pending.idleTimer);
			pending.idleTimer = undefined;
		}
	}

	private async handleMessage(msg: JsonRpcMessage): Promise<void> {
		// Any parseable agent message is a sign of life for idle watchdogs.
		this.touchActivity();

		const record = msg as unknown as Record<string, unknown>;
		const hasId =
			"id" in record && record.id !== undefined && record.id !== null;
		const hasMethod = "method" in record && typeof record.method === "string";
		const hasResultOrError = "result" in record || "error" in record;

		// Agent → client request: both id and method, not a response
		if (hasId && hasMethod && !hasResultOrError) {
			const id = record.id as JsonRpcId;
			const method = record.method as string;
			const params = record.params;
			try {
				const result = await this.dispatchAgentRequest(method, params);
				this.respond(id, result);
			} catch (err) {
				this.respondError(
					id,
					-32603,
					err instanceof Error ? err.message : String(err),
				);
			}
			return;
		}

		// Response to one of our requests
		if (hasId && hasResultOrError) {
			const response = msg as JsonRpcResponse;
			const pending = this.pending.get(response.id);
			if (!pending) {
				return;
			}
			this.clearPendingTimers(pending);
			this.pending.delete(response.id);
			if (response.error) {
				pending.reject(
					new Error(
						response.error.message ||
							`ACP error ${response.error.code ?? "unknown"}`,
					),
				);
			} else {
				pending.resolve(response.result);
			}
			return;
		}

		// Notification (method, no id)
		if (hasMethod && !hasId) {
			this.options.onNotification?.(msg as JsonRpcNotification);
		}
	}

	private async dispatchAgentRequest(
		method: string,
		params: unknown,
	): Promise<unknown> {
		if (this.options.onAgentRequest) {
			const custom = await this.options.onAgentRequest(method, params);
			if (custom !== undefined) {
				return custom;
			}
		}
		return defaultHandleAgentRequest(method, params);
	}

	private failAll(error: Error): void {
		for (const [, pending] of this.pending) {
			this.clearPendingTimers(pending);
			pending.reject(error);
		}
		this.pending.clear();
	}

	private cleanup(): void {
		this.closed = true;
		this.readline?.close();
		this.readline = null;
		this.proc = null;
		this.failAll(new Error("ACP client closed"));
	}
}

/**
 * Resolve wall-clock + idle timeouts from the legacy number form or options object.
 * Exported for unit tests.
 */
export function normalizeTimeoutOptions(
	timeoutOrOptions: number | AcpRequestTimeoutOptions | undefined,
	defaultWallMs: number | undefined,
): { timeoutMs: number; idleTimeoutMs: number } {
	if (typeof timeoutOrOptions === "number") {
		return {
			timeoutMs: timeoutOrOptions,
			idleTimeoutMs: 0,
		};
	}
	if (timeoutOrOptions && typeof timeoutOrOptions === "object") {
		const wall =
			timeoutOrOptions.timeoutMs !== undefined
				? timeoutOrOptions.timeoutMs
				: (defaultWallMs ?? 120_000);
		const idle =
			timeoutOrOptions.idleTimeoutMs !== undefined
				? timeoutOrOptions.idleTimeoutMs
				: 0;
		return { timeoutMs: wall, idleTimeoutMs: idle };
	}
	return {
		timeoutMs: defaultWallMs ?? 120_000,
		idleTimeoutMs: 0,
	};
}

/**
 * Default handlers for reverse RPC from the Grok agent.
 * Auto-approves permissions (edge workers are unattended).
 */
export function defaultHandleAgentRequest(
	method: string,
	params: unknown,
): unknown {
	if (
		method === "session/request_permission" ||
		method.endsWith("/request_permission")
	) {
		return autoApprovePermission(params);
	}

	// Do not advertise fs/terminal capabilities — if agent still asks, cancel safely.
	if (method.startsWith("fs/") || method.startsWith("terminal/")) {
		throw new Error(
			`Client capability not implemented: ${method}. Do not advertise fs/terminal in initialize.`,
		);
	}

	throw new Error(`Unsupported agent→client method: ${method}`);
}

function autoApprovePermission(params: unknown): unknown {
	const p = (params || {}) as {
		options?: Array<{
			optionId?: string;
			option_id?: string;
			kind?: string;
			name?: string;
		}>;
	};
	const options = Array.isArray(p.options) ? p.options : [];

	const allow =
		options.find((o) => {
			const kind = (o.kind || "").toLowerCase();
			const name = (o.name || "").toLowerCase();
			return (
				kind === "allowonce" ||
				kind === "allow_always" ||
				kind === "allowalways" ||
				kind === "allow" ||
				name.includes("allow")
			);
		}) || options[0];

	const optionId = allow?.optionId || allow?.option_id;
	if (optionId) {
		return {
			outcome: {
				outcome: "selected",
				optionId,
			},
		};
	}

	// No options advertised — cancel rather than hang
	return {
		outcome: {
			outcome: "cancelled",
		},
	};
}
