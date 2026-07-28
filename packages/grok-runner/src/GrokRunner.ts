import { EventEmitter } from "node:events";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	type WriteStream,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
	IAgentRunner,
	ILogger,
	IMessageFormatter,
	SDKMessage,
} from "cyrus-core";
import { createLogger } from "cyrus-core";
import { AcpClient } from "./backend/AcpClient.js";
import type {
	AcpAgentCapabilities,
	AcpAuthenticateResult,
	AcpInitializeResult,
	AcpSessionNewResult,
	AcpSessionPromptResult,
	AcpSessionUpdate,
	AcpSessionUpdateParams,
	JsonRpcNotification,
} from "./backend/acpTypes.js";
import { ensureGrokFolderTrust } from "./backend/folderTrust.js";
import {
	buildMcpExpandEnv,
	translateMcpConfigToAcp,
} from "./backend/mcpTranslator.js";
import { GrokMessageFormatter } from "./formatter.js";
import { GrokEventMapper } from "./GrokEventMapper.js";
import { hasGrokCachedAuth, resolveGrokBinary } from "./grokBinary.js";
import {
	buildRejectionOutcome,
	describePermissionRequest,
	evaluatePermissionRequest,
	translateToolRules,
} from "./toolPolicy.js";
import {
	GROK_DEFAULT_MODEL_SENTINEL,
	GROK_DEFAULT_TURN_IDLE_TIMEOUT_MS,
	type GrokRunnerConfig,
	type GrokRunnerEvents,
	type GrokSessionInfo,
} from "./types.js";

/**
 * How many times a turn may be restarted after a policy denial before we stop.
 * One is enough for "you cannot write, so summarise instead"; the cap exists so
 * an agent that keeps reaching for the same denied tool cannot loop forever.
 */
const MAX_DENIAL_CONTINUATIONS = 2;

export declare interface GrokRunner {
	on<K extends keyof GrokRunnerEvents>(
		event: K,
		listener: GrokRunnerEvents[K],
	): this;
	emit<K extends keyof GrokRunnerEvents>(
		event: K,
		...args: Parameters<GrokRunnerEvents[K]>
	): boolean;
}

/**
 * Runs Grok Build via ACP (`grok agent stdio`) and adapts events to
 * Cyrus's Claude-shaped SDKMessage bus.
 *
 * Auth is subscription-first: ACP `cached_token` from `grok login`
 * (browser OAuth → SuperGrok Heavy / etc.). `XAI_API_KEY` is only used
 * when no cached login is available.
 */
export class GrokRunner extends EventEmitter implements IAgentRunner {
	/**
	 * Mid-turn streaming is not supported yet. Follow-ups use a new
	 * process + `session/resume` or `session/load` (resumeSessionId) after
	 * the turn ends.
	 */
	readonly supportsStreamingInput = false;

	private readonly config: GrokRunnerConfig;
	private readonly formatter: IMessageFormatter;
	private readonly logger: ILogger;
	private sessionInfo: GrokSessionInfo | null = null;
	private client: AcpClient | null = null;
	private mapper: GrokEventMapper | null = null;
	private wasStopped = false;
	private messages: SDKMessage[] = [];
	/** Active ACP session id (for cancel/close on stop). */
	private activeSessionId: string | null = null;
	private supportsSessionClose = false;
	/** Session message bus log (~/.cyrus/logs/.../session-*.jsonl) */
	private logStream: WriteStream | null = null;
	/** Raw ACP session/update lines when CYRUS_LOG_LEVEL=DEBUG */
	private acpWireStream: WriteStream | null = null;
	private logDir: string | null = null;
	/** Tools refused by policy during the current turn (drives the continuation). */
	private deniedThisTurn: string[] = [];
	/** Every policy refusal in this session, surfaced on the result message. */
	private deniedThisSession: Array<{ tool: string; reason: string }> = [];

	constructor(config: GrokRunnerConfig) {
		super();
		this.config = config;
		this.formatter = new GrokMessageFormatter();
		this.logger = config.logger ?? createLogger({ component: "GrokRunner" });

		if (config.onMessage) this.on("message", config.onMessage);
		if (config.onError) this.on("error", config.onError);
		if (config.onComplete) this.on("complete", config.onComplete);
	}

	async start(prompt: string): Promise<GrokSessionInfo> {
		if (this.isRunning()) {
			throw new Error("Grok session already running");
		}

		this.sessionInfo = {
			sessionId: this.config.resumeSessionId || null,
			startedAt: new Date(),
			isRunning: true,
		};
		this.wasStopped = false;
		this.messages = [];
		this.deniedThisSession = [];
		this.activeSessionId = null;

		const workspace = resolve(this.config.workingDirectory || process.cwd());
		if (!existsSync(workspace)) {
			mkdirSync(workspace, { recursive: true });
		}

		// Grok drops project-scoped MCP names (from worktree `.mcp.json`) when the
		// workspace is untrusted. Headless ACP has no interactive trust prompt, so
		// grant trust for this session workspace (+ git main workdir for worktrees)
		// before spawning `grok agent`. Only touches ~/.grok/trusted_folders.toml.
		try {
			const trust = ensureGrokFolderTrust(workspace, {
				grokHome: this.config.grokHome || process.env.GROK_HOME || undefined,
			});
			if (trust.writtenPaths.length > 0) {
				this.logger.info(
					`Granted Grok folder trust for: ${trust.writtenPaths.join(", ")}`,
				);
			} else {
				this.logger.debug(
					`Grok folder trust already set for: ${trust.trustedPaths.join(", ") || workspace}`,
				);
			}
		} catch (trustError) {
			this.logger.warn(
				`Could not ensure Grok folder trust for ${workspace}: ${
					trustError instanceof Error ? trustError.message : String(trustError)
				}`,
			);
		}

		this.setupLogging(workspace);

		this.mapper = new GrokEventMapper({
			workingDirectory: workspace,
			model: this.resolvedModelId(),
			getSessionId: () => this.sessionInfo?.sessionId || "pending",
			emitMessage: (message) => {
				this.messages.push(message);
				this.writeSdkMessageLog(message);
				this.logger.debug(
					`SDK message type=${message.type}` +
						(message.type === "system"
							? ` subtype=${(message as { subtype?: string }).subtype}`
							: ""),
				);
				this.emit("message", message);
			},
			onSessionId: (sessionId) => {
				if (this.sessionInfo) {
					this.sessionInfo.sessionId = sessionId;
				}
				// Re-open logs under the real session id once assigned
				this.setupLogging(workspace, sessionId);
			},
		});

		this.logger.info(
			`Starting Grok session` +
				(this.config.resumeSessionId
					? ` (resume=${this.config.resumeSessionId})`
					: " (new)") +
				` cwd=${workspace}`,
		);

		let caughtError: unknown;
		try {
			await this.runSession(prompt, workspace);
		} catch (error) {
			caughtError = error;
			this.logger.error(
				"Grok session failed:",
				error instanceof Error ? error.message : String(error),
			);
		} finally {
			this.finalize(caughtError);
		}

		return this.sessionInfo;
	}

	async startStreaming(_initialPrompt?: string): Promise<GrokSessionInfo> {
		throw new Error(
			"GrokRunner does not support streaming input; use start() and resume between turns",
		);
	}

	addStreamMessage(_content: string): void {
		throw new Error("GrokRunner does not support streaming input messages");
	}

	completeStream(): void {
		// No-op
	}

	stop(): void {
		this.wasStopped = true;
		void this.gracefulStop();
		if (this.sessionInfo) {
			this.sessionInfo.isRunning = false;
		}
	}

	isRunning(): boolean {
		return this.sessionInfo?.isRunning ?? false;
	}

	getMessages(): SDKMessage[] {
		return [...this.messages];
	}

	getFormatter(): IMessageFormatter {
		return this.formatter;
	}

	// ---- internals ----------------------------------------------------------

	private resolvedModelId(): string | undefined {
		const model = this.config.model?.trim();
		if (!model || model === GROK_DEFAULT_MODEL_SENTINEL) {
			return undefined;
		}
		return model;
	}

	/**
	 * Resolve idle silence budget for `session/prompt`.
	 * Priority: config → GROK_TURN_IDLE_TIMEOUT_MS → default 15 min.
	 */
	private resolveTurnIdleTimeoutMs(): number {
		if (typeof this.config.turnIdleTimeoutMs === "number") {
			return Math.max(0, this.config.turnIdleTimeoutMs);
		}
		const fromEnv = process.env.GROK_TURN_IDLE_TIMEOUT_MS;
		if (fromEnv !== undefined && fromEnv !== "") {
			const parsed = Number(fromEnv);
			if (Number.isFinite(parsed) && parsed >= 0) {
				return parsed;
			}
		}
		return GROK_DEFAULT_TURN_IDLE_TIMEOUT_MS;
	}

	private buildAgentArgs(): string[] {
		// Permission rules are *global* flags: they must precede the `agent`
		// subcommand (verified against grok 0.2.111 — an invalid value there is
		// rejected by the parser, so they are genuinely read in this position).
		const args: string[] = [];
		const policy = translateToolRules(
			this.config.allowedTools,
			this.config.disallowedTools,
		);
		for (const rule of policy.allow) {
			args.push("--allow", rule);
		}
		for (const rule of policy.deny) {
			args.push("--deny", rule);
		}

		if (policy.untranslated.length > 0) {
			// Grok skips unknown tool names with a warning of its own, which is
			// easy to miss in a container log. Say it plainly: these granted
			// nothing, so anything relying on them is not actually permitted.
			this.logger.info(
				`Tool rules with no Grok equivalent (ignored): ${policy.untranslated.join(", ")}`,
			);
		}
		if (policy.scopedBashUnenforceable) {
			this.logger.info(
				"Bash is scoped to specific commands in allowedTools, which Grok cannot enforce with rules alone (deny beats allow) — no blanket Bash deny is sent. The scope is enforced client-side instead: every command in a shell call must match one of the grants, chained commands included.",
			);
		}
		if (policy.deny.length > 0) {
			// Info, not debug: this is the line that tells an operator what the
			// session is actually forbidden from doing.
			this.logger.info(
				`Grok permission rules — deny: ${policy.deny.join(", ")}${
					policy.allow.length > 0 ? ` | allow: ${policy.allow.join(", ")}` : ""
				}`,
			);
		}

		args.push("agent");
		const model = this.resolvedModelId();
		if (model) {
			args.push("--model", model);
		}
		// `--always-approve` (bypassPermissions) is what keeps an unattended
		// session from stalling on a prompt — but it is NOT safe to combine with
		// deny rules, despite the docs saying denials still apply. Verified live
		// on CYR-9: with `--deny Write` on the command line the agent wrote a file
		// anyway, and the session's ACP wire log held 746 updates and **zero**
		// `session/request_permission` calls. The flag short-circuits the rule
		// engine before deny is consulted, so the agent never even asks.
		//
		// With a restriction in force we therefore drop it and let the agent ask;
		// the client answers immediately from the policy (see `onAgentRequest` in
		// runSession), so nothing blocks waiting for a human.
		const alwaysApprove = this.config.alwaysApprove !== false;
		if (alwaysApprove && policy.deny.length === 0) {
			args.push("--always-approve");
		} else if (alwaysApprove) {
			this.logger.info(
				"Withholding --always-approve: it bypasses the deny rules for this session; permissions are enforced client-side instead.",
			);
		}
		args.push("stdio");
		return args;
	}

	/**
	 * Child env for the Grok process.
	 * Same pattern as Gemini/Codex: inherit process.env (keys stay available).
	 * Auth method is chosen explicitly via ACP `authenticate` — we prefer
	 * `cached_token` when auth.json exists; leaving XAI_API_KEY in the env is
	 * required so an authenticate fallback to `xai.api_key` can actually work
	 * on the already-spawned child (other runners do not strip API keys either).
	 */
	/**
	 * Child env for the Grok process.
	 * Inherits full process.env (Cyrus service EnvironmentFile keys such as
	 * EXA_API_KEY stay available). Gap-fills from `<workspace>/.env` without
	 * overriding existing process env, then forces GROK_HOME / no auto-update.
	 */
	private buildChildEnv(workspace?: string): NodeJS.ProcessEnv {
		const expanded = buildMcpExpandEnv(workspace);
		const env: NodeJS.ProcessEnv = {
			...expanded,
			GROK_DISABLE_AUTOUPDATER: "1",
		};
		const grokHome =
			this.config.grokHome || process.env.GROK_HOME || join(homedir(), ".grok");
		env.GROK_HOME = grokHome;
		return env;
	}

	private async runSession(prompt: string, workspace: string): Promise<void> {
		const binary = resolveGrokBinary(this.config.grokPath);
		const args = this.buildAgentArgs();
		const env = this.buildChildEnv(workspace);
		const policy = translateToolRules(
			this.config.allowedTools,
			this.config.disallowedTools,
		);

		this.logger.debug(`Spawning ACP: ${binary} ${args.join(" ")}`);

		// Control-plane RPCs (initialize / auth / session load) use a wall-clock
		// bound so a wedged child cannot hang setup forever. Match Codex app-server
		// default (60s). The agent *turn* uses an idle watchdog instead (see
		// session/prompt below): activity resets the timer; long productive work
		// is allowed.
		const client = new AcpClient({
			command: binary,
			args,
			cwd: workspace,
			env,
			requestTimeoutMs: 60_000,
			// Enforce the tool policy where ACP actually puts the decision: here.
			// Returning undefined falls through to the default auto-approve, which
			// is what an unrestricted session should keep doing.
			onAgentRequest: (method, params) => {
				if (!method.endsWith("request_permission")) {
					return undefined;
				}
				const verdict = evaluatePermissionRequest(params, policy);
				const { hints } = describePermissionRequest(params);
				const tool = hints[0] ?? "a tool";

				if (verdict.allowed) {
					// undefined falls through to the client's default auto-approve.
					this.writeAcpReverseRpcLog(method, params, undefined, "allowed");
					return undefined;
				}

				this.logger.info(`Denied a tool permission request: ${verdict.reason}`);
				this.deniedThisTurn.push(tool);
				this.deniedThisSession.push({ tool, reason: verdict.reason });
				const response = buildRejectionOutcome(params);
				this.writeAcpReverseRpcLog(method, params, response, "denied");
				return response;
			},
			onNotification: (n) => this.handleNotification(n),
			onStderr: (chunk) => {
				const text = chunk.trim();
				if (text) {
					// Grok stderr can be noisy (MCP auth); keep at debug unless error-looking
					if (/error|fatal|panic/i.test(text)) {
						this.logger.warn(`grok stderr: ${text.slice(0, 500)}`);
					} else {
						this.logger.debug(`grok stderr: ${text.slice(0, 500)}`);
					}
				}
			},
		});
		this.client = client;
		client.start();
		const init = (await client.request("initialize", {
			protocolVersion: 1,
			// Do not advertise fs/terminal unless reverse-RPC is implemented.
			clientCapabilities: {},
			clientInfo: { name: "cyrus-grok-runner", version: "0.2.66" },
		})) as AcpInitializeResult;

		const caps = init.agentCapabilities ?? {};
		this.supportsSessionClose = Boolean(caps.sessionCapabilities?.close);
		this.logger.debug(
			`ACP capabilities: loadSession=${Boolean(caps.loadSession)} resume=${Boolean(caps.sessionCapabilities?.resume)} mcp.http=${caps.mcpCapabilities?.http}`,
		);

		const authMethods = new Set((init.authMethods ?? []).map((m) => m.id));
		const methodId = this.pickAuthMethod(authMethods);
		if (!methodId) {
			throw new Error(
				"Grok is not authenticated. Run `grok login` (opens a browser for your Grok subscription), then restart Cyrus. API keys (XAI_API_KEY) are optional fallback for CI only.",
			);
		}

		let authResult: AcpAuthenticateResult;
		try {
			authResult = (await client.request("authenticate", {
				methodId,
				_meta: { headless: true },
			})) as AcpAuthenticateResult;
		} catch (authError) {
			// Fallback to API key if subscription auth failed
			if (
				methodId !== "xai.api_key" &&
				process.env.XAI_API_KEY &&
				authMethods.has("xai.api_key")
			) {
				this.logger.warn(
					`${methodId} auth failed, falling back to xai.api_key: ${
						authError instanceof Error ? authError.message : String(authError)
					}`,
				);
				authResult = (await client.request("authenticate", {
					methodId: "xai.api_key",
					_meta: { headless: true },
				})) as AcpAuthenticateResult;
			} else {
				throw authError;
			}
		}

		const tier = authResult?._meta?.subscription_tier;
		const email = authResult?._meta?.email;
		this.logger.info(
			`Authenticated via ${methodId}` +
				(tier ? ` (${tier})` : "") +
				(email ? ` as ${email}` : ""),
		);
		this.logger.event("grok_authenticated", {
			methodId,
			subscriptionTier: tier ?? null,
		});

		const expandEnv = buildMcpExpandEnv(workspace);
		const mcpServers = translateMcpConfigToAcp({
			workingDirectory: workspace,
			mcpConfigPath: this.config.mcpConfigPath,
			mcpConfig: this.config.mcpConfig,
			mcpCapabilities: caps.mcpCapabilities,
			env: expandEnv,
		});
		// INFO so live verification does not require DEBUG
		this.logger.info(
			`MCP servers for session: ${mcpServers.map((s) => s.name).join(", ") || "(none)"}`,
		);

		const sessionMeta: Record<string, unknown> = {};
		if (this.config.appendSystemPrompt) {
			sessionMeta.rules = this.config.appendSystemPrompt;
		}

		const { sessionId, currentModel } = await this.openOrResumeSession(
			client,
			caps,
			workspace,
			mcpServers,
			sessionMeta,
		);

		this.activeSessionId = sessionId;
		this.mapper?.emitInit(sessionId, currentModel || this.resolvedModelId());
		if (currentModel) {
			this.mapper?.setModel(currentModel);
		}
		this.logger.info(
			`Session ready id=${sessionId} model=${currentModel || this.resolvedModelId() || "default"}`,
		);

		if (this.wasStopped) {
			return;
		}

		const turnIdleTimeoutMs = this.resolveTurnIdleTimeoutMs();
		const turnTimeoutOpts = {
			// No absolute wall-clock on the turn (unlike the previous 1h hard cap).
			// Idle-only: any ACP notification or reverse RPC resets the watchdog.
			timeoutMs: 0,
			idleTimeoutMs: turnIdleTimeoutMs,
		};
		this.logger.debug(
			`session/prompt starting (${prompt.length} chars)` +
				(turnIdleTimeoutMs > 0
					? ` idleTimeoutMs=${turnIdleTimeoutMs}`
					: " idleTimeout=disabled"),
		);
		this.deniedThisTurn = [];
		let promptResult = (await client.request(
			"session/prompt",
			{
				sessionId,
				prompt: [{ type: "text", text: prompt }],
			},
			turnTimeoutOpts,
		)) as AcpSessionPromptResult;

		if (this.wasStopped) {
			return;
		}

		this.logger.info(
			`session/prompt finished stopReason=${promptResult?.stopReason ?? "unknown"}`,
		);

		// A denied tool ends the turn. Observed on CYR-12: the read-only session
		// asked to write, was refused, and stopped there — Linear kept only the
		// half-finished sentence it had streamed before the attempt. The agent
		// treats the refusal as "the user stopped me", which is right for an
		// interactive client and wrong for us: the denial is a standing policy,
		// not a human changing their mind.
		//
		// So tell it that, and let it finish with the tools it does have. Bounded,
		// because an agent that keeps reaching for the same denied tool would
		// otherwise ping-pong here forever.
		let continuations = 0;
		while (
			this.deniedThisTurn.length > 0 &&
			continuations < MAX_DENIAL_CONTINUATIONS &&
			!this.wasStopped
		) {
			const denied = [...new Set(this.deniedThisTurn)];
			this.deniedThisTurn = [];
			continuations++;

			this.logger.info(
				`Turn ended after denying ${denied.join(", ")}; asking the agent to continue without it (${continuations}/${MAX_DENIAL_CONTINUATIONS})`,
			);

			promptResult = (await client.request(
				"session/prompt",
				{
					sessionId,
					prompt: [
						{
							type: "text",
							text:
								`Your ${denied.join(" and ")} call was blocked by this session's tool policy. ` +
								"That is a standing restriction on this session, not a human interrupting you, " +
								"and retrying it or working around it will not succeed. " +
								"Continue with the tools you do have and finish your response, " +
								"reporting what you could not do and why.",
						},
					],
				},
				turnTimeoutOpts,
			)) as AcpSessionPromptResult;

			this.logger.info(
				`continuation prompt finished stopReason=${promptResult?.stopReason ?? "unknown"}`,
			);
		}

		if (this.deniedThisTurn.length > 0) {
			this.logger.info(
				`Stopping after ${MAX_DENIAL_CONTINUATIONS} continuations; the agent kept requesting denied tools.`,
			);
		}

		if (this.wasStopped) {
			return;
		}

		this.mapper?.finalize({
			stopReason: promptResult?.stopReason,
			permissionDenials: this.deniedThisSession,
		});
	}

	/**
	 * Open a new session or resume/load an existing one.
	 *
	 * Preference order for continuations:
	 * 1. session/resume (no history replay) when advertised
	 * 2. session/load with update suppression (replay ignored for Linear)
	 * 3. session/new if resume/load fail (with a clear warning)
	 */
	private async openOrResumeSession(
		client: AcpClient,
		caps: AcpAgentCapabilities,
		workspace: string,
		mcpServers: ReturnType<typeof translateMcpConfigToAcp>,
		sessionMeta: Record<string, unknown>,
	): Promise<{ sessionId: string; currentModel?: string }> {
		const baseParams = {
			cwd: workspace,
			mcpServers,
			...(Object.keys(sessionMeta).length > 0 ? { _meta: sessionMeta } : {}),
		};

		const resumeId = this.config.resumeSessionId;
		if (!resumeId) {
			const created = (await client.request("session/new", {
				...baseParams,
			})) as AcpSessionNewResult | null;
			const sessionId = created?.sessionId;
			if (!sessionId) {
				throw new Error("Grok ACP session/new did not return a sessionId");
			}
			return {
				sessionId,
				currentModel: created?.models?.currentModelId,
			};
		}

		const canResume = Boolean(caps.sessionCapabilities?.resume);
		const canLoad = Boolean(caps.loadSession);

		if (canResume) {
			try {
				const resumed = (await client.request("session/resume", {
					sessionId: resumeId,
					...baseParams,
				})) as AcpSessionNewResult | null;
				const sessionId = resumed?.sessionId || resumeId;
				this.logger.info(`Resumed session ${sessionId} (no replay)`);
				return {
					sessionId,
					currentModel: resumed?.models?.currentModelId,
				};
			} catch (resumeError) {
				this.logger.warn(
					`session/resume failed: ${
						resumeError instanceof Error
							? resumeError.message
							: String(resumeError)
					}; trying session/load`,
				);
			}
		}

		if (canLoad || !canResume) {
			// Suppress load replay so Linear is not re-spammed with history.
			this.mapper?.setSuppressUpdates(true);
			try {
				const loaded = (await client.request("session/load", {
					sessionId: resumeId,
					...baseParams,
				})) as AcpSessionNewResult | null | undefined;
				// ACP says load result is often null; use requested id.
				const sessionId = loaded?.sessionId || resumeId;
				this.logger.info(
					`Loaded session ${sessionId} (replay suppressed for Linear)`,
				);
				return {
					sessionId,
					currentModel: loaded?.models?.currentModelId,
				};
			} catch (loadError) {
				this.logger.warn(
					`session/load failed for ${resumeId}: ${
						loadError instanceof Error ? loadError.message : String(loadError)
					}; starting a NEW session (history continuity lost)`,
				);
			} finally {
				this.mapper?.setSuppressUpdates(false);
			}
		}

		const created = (await client.request("session/new", {
			...baseParams,
		})) as AcpSessionNewResult | null;
		const sessionId = created?.sessionId;
		if (!sessionId) {
			throw new Error(
				"Grok ACP could not resume or create a session (no sessionId)",
			);
		}
		return {
			sessionId,
			currentModel: created?.models?.currentModelId,
		};
	}

	/**
	 * Prefer subscription login (`cached_token` from `grok login`).
	 */
	private pickAuthMethod(authMethods: Set<string>): string | null {
		const hasAuthFile = hasGrokCachedAuth(this.config.grokHome);

		if (authMethods.has("cached_token") && hasAuthFile) {
			return "cached_token";
		}

		if (process.env.XAI_API_KEY && authMethods.has("xai.api_key")) {
			return "xai.api_key";
		}

		// Agent may still have a valid token even if we couldn't see the file
		if (authMethods.has("cached_token")) {
			return "cached_token";
		}

		return null;
	}

	private handleNotification(notification: JsonRpcNotification): void {
		if (notification.method !== "session/update") {
			this.logger.debug(`ACP notification method=${notification.method}`);
			return;
		}
		const params = notification.params as AcpSessionUpdateParams | undefined;
		const update = params?.update as AcpSessionUpdate | undefined;
		if (!update) return;

		this.writeAcpWireLog(update);

		if (params?.sessionId && this.sessionInfo && !this.sessionInfo.sessionId) {
			this.sessionInfo.sessionId = params.sessionId;
		}

		this.mapper?.handleUpdate(update);
	}

	/**
	 * Write session SDKMessage + ACP wire logs under cyrusHome/logs (Claude parity).
	 * Paths are printed at INFO so operators know what to attach when filing issues.
	 */
	private setupLogging(workspace: string, sessionId?: string | null): void {
		try {
			const cyrusHome = this.config.cyrusHome || join(homedir(), ".cyrus");
			const workspaceName =
				this.config.workspaceName ||
				workspace.split("/").filter(Boolean).pop() ||
				"workspace";
			const logsDir = join(cyrusHome, "logs", workspaceName);
			mkdirSync(logsDir, { recursive: true });

			const id =
				sessionId ||
				this.sessionInfo?.sessionId ||
				this.config.resumeSessionId ||
				"pending";
			const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
			const sdkPath = join(logsDir, `session-grok-${id}-${timestamp}.jsonl`);
			const acpPath = join(logsDir, `acp-wire-grok-${id}-${timestamp}.jsonl`);

			// Close previous streams if re-opening after session id assignment
			this.closeLogStreams();

			this.logStream = createWriteStream(sdkPath, { flags: "a" });
			this.acpWireStream = createWriteStream(acpPath, { flags: "a" });
			this.logDir = logsDir;

			this.logStream.write(
				`${JSON.stringify({
					type: "session-metadata",
					sessionId: id,
					resumeSessionId: this.config.resumeSessionId ?? null,
					workingDirectory: workspace,
					model: this.config.model ?? null,
					timestamp: new Date().toISOString(),
				})}\n`,
			);

			this.logger.info(`Session SDK log: ${sdkPath}`);
			this.logger.info(`Session ACP wire log: ${acpPath}`);
		} catch (err) {
			this.logger.warn(
				`Failed to set up session logs: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	private writeSdkMessageLog(message: SDKMessage): void {
		if (!this.logStream) return;
		try {
			this.logStream.write(
				`${JSON.stringify({
					type: "sdk-message",
					message,
					timestamp: new Date().toISOString(),
				})}\n`,
			);
		} catch {
			// ignore write errors
		}
	}

	private writeAcpWireLog(update: AcpSessionUpdate): void {
		this.writeAcpWireEntry({ type: "session-update", update });
	}

	/**
	 * Record an agent→client request and the answer we gave it.
	 *
	 * Until this existed the wire log held only `session-update` notifications,
	 * so the permission handshake was invisible: diagnosing CYR-12 meant proving
	 * a negative from 746 lines that *couldn't* have contained the evidence
	 * either way. Permission decisions are the one part of a restricted session
	 * an operator most needs to audit, so they belong on the wire.
	 */
	private writeAcpReverseRpcLog(
		method: string,
		params: unknown,
		response: unknown,
		decision: "allowed" | "denied" | "passthrough",
	): void {
		this.writeAcpWireEntry({
			type: "agent-request",
			method,
			decision,
			params,
			response,
		});
	}

	private writeAcpWireEntry(entry: Record<string, unknown>): void {
		if (!this.acpWireStream) return;
		try {
			this.acpWireStream.write(
				`${JSON.stringify({
					...entry,
					timestamp: new Date().toISOString(),
				})}\n`,
			);
		} catch {
			// ignore
		}
	}

	private closeLogStreams(): void {
		if (this.logStream) {
			this.logStream.end();
			this.logStream = null;
		}
		if (this.acpWireStream) {
			this.acpWireStream.end();
			this.acpWireStream = null;
		}
	}

	private async gracefulStop(): Promise<void> {
		const client = this.client;
		const sessionId = this.activeSessionId;
		if (client?.isRunning() && sessionId) {
			try {
				// Cancel in-flight turn first
				await client.request("session/cancel", { sessionId }, 5_000);
			} catch {
				// ignore
			}
			if (this.supportsSessionClose) {
				try {
					await client.request("session/close", { sessionId }, 5_000);
				} catch {
					// ignore
				}
			}
		}
		client?.kill("SIGTERM");
		this.client = null;
		this.activeSessionId = null;
	}

	private finalize(error?: unknown): void {
		if (this.mapper && this.messages.every((m) => m.type !== "result")) {
			this.mapper.finalize({
				error,
				wasStopped: this.wasStopped,
			});
		}

		if (this.sessionInfo) {
			this.sessionInfo.isRunning = false;
		}

		// Best-effort kill if stop() was not called
		if (this.client) {
			void this.gracefulStop();
		}

		this.closeLogStreams();
		if (this.logDir) {
			this.logger.debug(`Session logs closed under ${this.logDir}`);
		}

		if (error && !this.wasStopped) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.emit("error", err);
		}

		this.logger.event("grok_session_complete", {
			sessionId: this.sessionInfo?.sessionId ?? null,
			messageCount: this.messages.length,
			wasStopped: this.wasStopped,
			hadError: Boolean(error),
		});

		this.emit("complete", this.messages);
	}
}
