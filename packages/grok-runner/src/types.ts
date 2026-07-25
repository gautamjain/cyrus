import type {
	AgentRunnerConfig,
	AgentSessionInfo,
	SDKMessage,
} from "cyrus-core";

/**
 * Configuration for GrokRunner.
 *
 * Auth preference (subscription-first):
 * 1. Cached Grok CLI login (`~/.grok/auth.json` via ACP `cached_token`)
 * 2. Optional `XAI_API_KEY` only when no cached session (CI / headless hosts)
 */
export interface GrokRunnerConfig extends AgentRunnerConfig {
	/** Path to grok CLI binary (defaults to PATH / ~/.grok/bin/grok) */
	grokPath?: string;
	/**
	 * Override GROK_HOME for the child process.
	 * Defaults to process GROK_HOME, then ~/.grok.
	 */
	grokHome?: string;
	/**
	 * When true (default), auto-approve all tool executions via
	 * `grok agent --always-approve`. Required for unattended edge workers.
	 */
	alwaysApprove?: boolean;
	/**
	 * Fail an in-flight `session/prompt` if Grok produces **no ACP activity**
	 * for this many milliseconds (default **5 minutes**, same idea as Codex's
	 * `turnIdleTimeoutMs`).
	 *
	 * Any agent traffic resets the timer: `session/update` notifications,
	 * reverse RPCs (`session/request_permission`, …). Productive multi-hour
	 * turns stay alive; a wedged silent process still fails.
	 *
	 * Set to `0` to disable the idle watchdog (turn ends only on ACP result,
	 * process exit, or explicit stop). Override via env
	 * `GROK_TURN_IDLE_TIMEOUT_MS` when unset on the config object.
	 */
	turnIdleTimeoutMs?: number;
}

/**
 * Default idle silence before failing `session/prompt` (Codex default: 5 min).
 * Wall-clock turn limits are intentionally not used for prompts.
 */
export const GROK_DEFAULT_TURN_IDLE_TIMEOUT_MS = 300_000;

export interface GrokSessionInfo extends AgentSessionInfo {
	sessionId: string | null;
}

export interface GrokRunnerEvents {
	message: (message: SDKMessage) => void;
	error: (error: Error) => void;
	complete: (messages: SDKMessage[]) => void;
}

/**
 * Sentinel model value meaning "use whatever Grok Build currently defaults to".
 * GrokRunner omits `-m` when this is set so new model releases do not require
 * a Cyrus config update.
 */
export const GROK_DEFAULT_MODEL_SENTINEL = "default";
