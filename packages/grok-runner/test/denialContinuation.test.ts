import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Drives a whole turn against a fake ACP agent to prove the fix for the
 * behaviour observed on CYR-12: a policy denial ended the turn, so the session
 * posted only the half-finished sentence it had streamed before the attempt.
 */

type RequestLog = { method: string; params: unknown };

const requests: RequestLog[] = [];
/** Permission requests the fake agent will raise, in order. */
let pendingPermissionRequests: unknown[] = [];

class FakeAcpClient {
	private onAgentRequest: (
		method: string,
		params: unknown,
	) => Promise<unknown> | unknown;

	constructor(options: {
		onAgentRequest: (m: string, p: unknown) => Promise<unknown> | unknown;
	}) {
		this.onAgentRequest = options.onAgentRequest;
	}

	async start(): Promise<void> {}

	/** Both are called by the runner during teardown. */
	isRunning(): boolean {
		return false;
	}

	kill(_signal?: string): void {}

	async request(method: string, params: unknown): Promise<unknown> {
		requests.push({ method, params });

		switch (method) {
			case "initialize":
				return {
					protocolVersion: 1,
					agentCapabilities: { mcpCapabilities: { http: true } },
					authMethods: [{ id: "cached_token" }],
				};
			case "authenticate":
				return {};
			case "session/new":
				return { sessionId: "session-under-test" };
			case "session/prompt": {
				// On the first turn the agent tries a tool; the client's policy
				// decides. A denial is what historically ended the turn.
				const next = pendingPermissionRequests.shift();
				if (next) {
					await this.onAgentRequest("session/request_permission", next);
				}
				return { stopReason: "end_turn" };
			}
			default:
				return {};
		}
	}

	async close(): Promise<void> {}
}

vi.mock("../src/backend/AcpClient.js", () => ({
	AcpClient: FakeAcpClient,
	defaultHandleAgentRequest: () => ({ outcome: { outcome: "cancelled" } }),
}));

vi.mock("../src/grokBinary.js", () => ({
	resolveGrokBinary: () => "/usr/local/bin/grok",
	hasGrokCachedAuth: () => true,
}));

const { GrokRunner } = await import("../src/GrokRunner.js");

/** A permission request for a `write`, shaped like the real CYR-12 payload. */
const writePermissionRequest = {
	options: [
		{ optionId: "allow-once", kind: "allow_once", name: "Yes" },
		{ optionId: "reject-once", kind: "reject_once", name: "No" },
	],
	toolCall: {
		title: "write",
		_meta: {
			"x.ai/tool": { name: "write", kind: "write", read_only: false },
		},
	},
};

function promptCalls() {
	return requests.filter((r) => r.method === "session/prompt");
}

function makeRunner(allowedTools?: string[]) {
	return new GrokRunner({
		cyrusHome: "/tmp/cyrus-test",
		workingDirectory: "/tmp",
		...(allowedTools ? { allowedTools } : {}),
		// biome-ignore lint/suspicious/noExplicitAny: test config shim
	} as any);
}

describe("continuing a turn after a policy denial", () => {
	beforeEach(() => {
		requests.length = 0;
		pendingPermissionRequests = [];
	});

	it("re-prompts so the agent finishes instead of stopping at the refusal", async () => {
		pendingPermissionRequests = [writePermissionRequest];
		// A read-only allow-list, which denies Write.
		await makeRunner(["Read(**)", "mcp__linear"]).start("review this");

		const prompts = promptCalls();
		expect(prompts).toHaveLength(2);

		const continuation = JSON.stringify(prompts[1]?.params);
		expect(continuation).toContain("blocked by this session's tool policy");
		expect(continuation).toContain("write");
		// It must be told this is standing policy, not a human interrupting,
		// otherwise it retries the same call.
		expect(continuation).toContain("not a human interrupting");
	});

	it("does not re-prompt when nothing was denied", async () => {
		pendingPermissionRequests = [];
		await makeRunner(["Read(**)"]).start("just read");
		expect(promptCalls()).toHaveLength(1);
	});

	it("does not re-prompt when the session is unrestricted", async () => {
		// No allow-list ⇒ no deny rules ⇒ the request is approved, not denied.
		pendingPermissionRequests = [writePermissionRequest];
		await makeRunner().start("do work");
		expect(promptCalls()).toHaveLength(1);
	});

	it("stops after the cap rather than ping-ponging forever", async () => {
		// The agent reaches for the denied tool on every turn.
		pendingPermissionRequests = [
			writePermissionRequest,
			writePermissionRequest,
			writePermissionRequest,
			writePermissionRequest,
		];
		await makeRunner(["Read(**)"]).start("keep trying");

		// 1 original + MAX_DENIAL_CONTINUATIONS (2)
		expect(promptCalls()).toHaveLength(3);
	});
});

describe("reporting denials on the result message", () => {
	beforeEach(() => {
		requests.length = 0;
		pendingPermissionRequests = [];
	});

	it("names the refused tool in permission_denials", async () => {
		pendingPermissionRequests = [writePermissionRequest];
		const runner = makeRunner(["Read(**)"]);
		await runner.start("try to write");

		const result = runner
			.getMessages()
			.find((m) => m.type === "result") as unknown as {
			permission_denials: Array<{ tool_name: string; reason: string }>;
		};

		// Previously hard-coded empty, so a caller could not tell "chose not to"
		// from "was not allowed to".
		expect(result.permission_denials).toHaveLength(1);
		expect(result.permission_denials[0]?.tool_name).toBe("write");
		expect(result.permission_denials[0]?.reason).toMatch(/denied/i);
	});

	it("leaves permission_denials empty when nothing was refused", async () => {
		pendingPermissionRequests = [];
		const runner = makeRunner(["Read(**)"]);
		await runner.start("just read");

		const result = runner
			.getMessages()
			.find((m) => m.type === "result") as unknown as {
			permission_denials: unknown[];
		};
		expect(result.permission_denials).toEqual([]);
	});
});

describe("auditing the permission handshake on the wire", () => {
	beforeEach(() => {
		requests.length = 0;
		pendingPermissionRequests = [];
	});

	it("records the request and our answer, so a denial is provable after the fact", async () => {
		// The gap this closes: diagnosing CYR-12 meant proving a negative from a
		// log that could not have held the evidence either way.
		const home = mkdtempSync(join(tmpdir(), "cyrus-wire-"));
		pendingPermissionRequests = [writePermissionRequest];

		const runner = new GrokRunner({
			cyrusHome: home,
			workingDirectory: "/tmp",
			workspaceName: "CYR-TEST",
			allowedTools: ["Read(**)"],
			// biome-ignore lint/suspicious/noExplicitAny: test config shim
		} as any);
		await runner.start("try to write");

		// Two wire files exist per session: logging is opened once as "pending"
		// and re-opened under the real session id, so read them all. The streams
		// also flush asynchronously after start() resolves.
		const logsDir = join(home, "logs", "CYR-TEST");
		let lines: Array<Record<string, unknown>> = [];
		for (let attempt = 0; attempt < 40 && lines.length === 0; attempt++) {
			lines = readdirSync(logsDir)
				.filter((f) => f.startsWith("acp-wire-grok-"))
				.flatMap((f) =>
					readFileSync(join(logsDir, f), "utf8")
						.trim()
						.split("\n")
						.filter(Boolean)
						.map((l) => JSON.parse(l)),
				);
			if (lines.length === 0) {
				await new Promise((r) => setTimeout(r, 25));
			}
		}
		expect(lines.length).toBeGreaterThan(0);

		const handshake = lines.find((l) => l.type === "agent-request");
		expect(handshake).toBeDefined();
		expect(handshake.method).toContain("request_permission");
		expect(handshake.decision).toBe("denied");
		// Both halves must be there: what was asked, and what we answered.
		expect(JSON.stringify(handshake.params)).toContain("write");
		expect(JSON.stringify(handshake.response)).toContain("outcome");
	});
});
