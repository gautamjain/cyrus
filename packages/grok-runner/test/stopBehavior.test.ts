/**
 * Black-box: mid-turn stop / force re-prompt (Linear "send while working").
 *
 * Codex suppresses a terminal result when the runner was intentionally stopped;
 * Claude treats AbortError as a normal stop, not a failure. Grok must match:
 * EdgeWorker calls stop() then starts a new turn — the killed turn must not
 * post `is_error` / "ACP client closed" to Linear as "Error from Cyrus".
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

type RequestLog = { method: string; params: unknown };

const requests: RequestLog[] = [];
/** Resolvers for in-flight session/prompt calls so kill() can fail them like AcpClient.cleanup. */
let pendingPromptRejects: Array<(err: Error) => void> = [];
/** When true, session/prompt hangs until kill() (models mid-turn work). */
let hangPrompt = false;

class FakeAcpClient {
	private closed = false;
	private onAgentRequest?: (
		method: string,
		params: unknown,
	) => Promise<unknown> | unknown;

	constructor(options: {
		onAgentRequest?: (m: string, p: unknown) => Promise<unknown> | unknown;
	}) {
		this.onAgentRequest = options.onAgentRequest;
	}

	start(): void {}

	isRunning(): boolean {
		return !this.closed;
	}

	kill(_signal?: string): void {
		this.closed = true;
		// Mirror AcpClient.cleanup → failAll(new Error("ACP client closed"))
		const rejects = pendingPromptRejects.splice(0);
		for (const reject of rejects) {
			reject(new Error("ACP client closed"));
		}
	}

	async request(method: string, params: unknown): Promise<unknown> {
		requests.push({ method, params });

		switch (method) {
			case "initialize":
				return {
					protocolVersion: 1,
					agentCapabilities: {
						loadSession: true,
						mcpCapabilities: { http: true },
					},
					authMethods: [{ id: "cached_token" }],
				};
			case "authenticate":
				return {};
			case "session/new":
				return { sessionId: "sess-stop-test" };
			case "session/load":
				return { sessionId: "sess-stop-test" };
			case "session/prompt": {
				if (hangPrompt) {
					return new Promise((_resolve, reject) => {
						pendingPromptRejects.push(reject);
					});
				}
				return { stopReason: "end_turn" };
			}
			case "session/cancel":
			case "session/close":
				return {};
			default:
				return {};
		}
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

vi.mock("../src/backend/AcpClient.js", () => ({
	AcpClient: FakeAcpClient,
	defaultHandleAgentRequest: () => ({
		outcome: { outcome: "selected", optionId: "allow-once" },
	}),
}));

vi.mock("../src/grokBinary.js", () => ({
	resolveGrokBinary: () => "/usr/local/bin/grok",
	hasGrokCachedAuth: () => true,
}));

const { GrokRunner } = await import("../src/GrokRunner.js");

function makeRunner(workdir: string) {
	const messages: import("cyrus-core").SDKMessage[] = [];
	const errors: Error[] = [];
	const runner = new GrokRunner({
		cyrusHome: join(workdir, "cyrus-home"),
		workingDirectory: workdir,
		onMessage: (m) => messages.push(m),
		onError: (e) => errors.push(e),
		// biome-ignore lint/suspicious/noExplicitAny: test config shim
	} as any);
	return { runner, messages, errors };
}

function resultMessages(messages: import("cyrus-core").SDKMessage[]) {
	return messages.filter((m) => m.type === "result");
}

describe("stop during an in-flight turn (force re-prompt)", () => {
	let workdir: string;

	beforeEach(() => {
		requests.length = 0;
		pendingPromptRejects = [];
		hangPrompt = true;
		workdir = mkdtempSync(join(tmpdir(), "grok-stop-"));
	});

	it("does not emit an is_error result when stop() kills the ACP client mid-prompt", async () => {
		const { runner, messages, errors } = makeRunner(workdir);

		const started = runner.start("work on BAR-59");

		// Wait until the hang is armed (prompt in flight).
		await vi.waitFor(() => {
			expect(pendingPromptRejects.length).toBeGreaterThan(0);
		});

		// EdgeWorker mid-turn path: stop existing runner, then resume with a new one.
		runner.stop();
		await started;

		const results = resultMessages(messages);
		// Codex: intentional stop → no terminal error result for Linear.
		expect(
			results.filter((m) => (m as { is_error?: boolean }).is_error),
		).toEqual([]);
		// Teardown noise must not surface as runner "error" event either.
		expect(errors).toEqual([]);
		// Must not look like the BAR-59 Linear "Error from Cyrus" body.
		const errorBodies = results.flatMap((m) => {
			const errs = (m as { errors?: string[] }).errors;
			return Array.isArray(errs) ? errs : [];
		});
		expect(errorBodies.join(" ")).not.toContain("ACP client closed");
	});

	it("still reports a real failure when the client closes without stop()", async () => {
		const { runner, messages, errors } = makeRunner(workdir);

		const started = runner.start("work on BAR-59");
		await vi.waitFor(() => {
			expect(pendingPromptRejects.length).toBeGreaterThan(0);
		});

		// Unexpected process death: same reject shape, but wasStopped stays false.
		const reject = pendingPromptRejects.shift();
		reject?.(new Error("ACP client closed"));
		await started;

		const results = resultMessages(messages);
		expect(results.length).toBeGreaterThanOrEqual(1);
		const last = results[results.length - 1] as {
			is_error?: boolean;
			errors?: string[];
		};
		expect(last.is_error).toBe(true);
		expect(last.errors?.join(" ")).toContain("ACP client closed");
		expect(errors.length).toBeGreaterThanOrEqual(1);
	});
});

describe("normal completion still emits success", () => {
	let workdir: string;

	beforeEach(() => {
		requests.length = 0;
		pendingPromptRejects = [];
		hangPrompt = false;
		workdir = mkdtempSync(join(tmpdir(), "grok-stop-ok-"));
	});

	it("emits a non-error result when the turn finishes cleanly", async () => {
		const { runner, messages, errors } = makeRunner(workdir);
		await runner.start("say hello");

		const results = resultMessages(messages);
		expect(results.length).toBe(1);
		expect((results[0] as { is_error?: boolean }).is_error).toBe(false);
		expect(errors).toEqual([]);
	});
});
