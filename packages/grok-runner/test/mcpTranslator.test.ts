import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	autoDetectMcpConfigPath,
	buildMcpExpandEnv,
	collectMcpConfigPaths,
	expandEnvInString,
	loadDotEnvFile,
	resolveMcpConfigFilePath,
	toAcpNameValueList,
	translateMcpConfigToAcp,
} from "../src/backend/mcpTranslator.js";

describe("toAcpNameValueList", () => {
	it("converts record to name/value array", () => {
		expect(
			toAcpNameValueList({ Authorization: "Bearer x", "X-A": "1" }),
		).toEqual([
			{ name: "Authorization", value: "Bearer x" },
			{ name: "X-A", value: "1" },
		]);
	});

	it("handles undefined", () => {
		expect(toAcpNameValueList(undefined)).toEqual([]);
	});
});

describe("expandEnvInString", () => {
	it("expands ${VAR} when set", () => {
		expect(expandEnvInString("Bearer ${TOKEN}", { TOKEN: "abc" })).toBe(
			"Bearer abc",
		);
	});

	it("uses ${VAR:-default} when unset or empty", () => {
		expect(expandEnvInString("${X:-fallback}", {})).toBe("fallback");
		expect(expandEnvInString("${X:-fallback}", { X: "" })).toBe("fallback");
	});

	it("empty string for unknown var without default", () => {
		expect(expandEnvInString("k=${MISSING}", {})).toBe("k=");
	});
});

describe("loadDotEnvFile / buildMcpExpandEnv", () => {
	it("gap-fills from .env without overriding base", () => {
		const dir = mkdtempSync(join(tmpdir(), "grok-mcp-dotenv-"));
		writeFileSync(
			join(dir, ".env"),
			'EXA_API_KEY=from-file\nALREADY=from-file\n# comment\nOTHER="quoted"\n',
		);
		const env = loadDotEnvFile(join(dir, ".env"), {
			ALREADY: "from-process",
		});
		expect(env.ALREADY).toBe("from-process");
		expect(env.EXA_API_KEY).toBe("from-file");
		expect(env.OTHER).toBe("quoted");
	});

	it("buildMcpExpandEnv includes process.env and worktree .env gaps", () => {
		const dir = mkdtempSync(join(tmpdir(), "grok-mcp-expand-"));
		writeFileSync(join(dir, ".env"), "GROK_TEST_ONLY_KEY=worktree-value\n");
		const env = buildMcpExpandEnv(dir);
		expect(env.GROK_TEST_ONLY_KEY).toBe("worktree-value");
		// process PATH should still be present
		expect(env.PATH || env.Path).toBeTruthy();
	});
});

describe("path recovery", () => {
	it("autoDetectMcpConfigPath finds worktree .mcp.json", () => {
		const dir = mkdtempSync(join(tmpdir(), "grok-mcp-auto-"));
		writeFileSync(
			join(dir, ".mcp.json"),
			JSON.stringify({
				mcpServers: { context: { command: "context", args: ["serve"] } },
			}),
		);
		expect(autoDetectMcpConfigPath(dir)).toBe(join(dir, ".mcp.json"));
	});

	it("resolveMcpConfigFilePath recovers broken absolute against worktree", () => {
		const dir = mkdtempSync(join(tmpdir(), "grok-mcp-recover-"));
		const good = join(dir, ".mcp.json");
		writeFileSync(
			good,
			JSON.stringify({
				mcpServers: { context: { command: "context", args: [] } },
			}),
		);
		// Simulate Edge resolvePath(".mcp.json") under cwd=/
		expect(resolveMcpConfigFilePath("/.mcp.json", dir)).toBe(good);
		expect(resolveMcpConfigFilePath(".mcp.json", dir)).toBe(good);
	});

	it("collectMcpConfigPaths includes auto-detect and recovered explicit", () => {
		const dir = mkdtempSync(join(tmpdir(), "grok-mcp-collect-"));
		writeFileSync(
			join(dir, ".mcp.json"),
			JSON.stringify({
				mcpServers: { exa: { type: "http", url: "https://example.com" } },
			}),
		);
		const paths = collectMcpConfigPaths("/.mcp.json", dir);
		expect(paths).toContain(join(dir, ".mcp.json"));
		expect(paths.length).toBeGreaterThanOrEqual(1);
	});
});

describe("translateMcpConfigToAcp", () => {
	const prevExa = process.env.EXA_API_KEY;
	afterEach(() => {
		if (prevExa === undefined) delete process.env.EXA_API_KEY;
		else process.env.EXA_API_KEY = prevExa;
	});

	it("encodes HTTP headers as name/value arrays when http capability is true", () => {
		const servers = translateMcpConfigToAcp({
			mcpConfig: {
				linear: {
					type: "http",
					url: "https://mcp.linear.app/mcp",
					headers: { Authorization: "Bearer tok" },
				} as any,
			},
			mcpCapabilities: { http: true },
		});

		expect(servers).toHaveLength(1);
		expect(servers[0]).toMatchObject({
			name: "linear",
			type: "http",
			url: "https://mcp.linear.app/mcp",
			headers: [{ name: "Authorization", value: "Bearer tok" }],
		});
	});

	it("encodes stdio env as name/value arrays and requires args", () => {
		const servers = translateMcpConfigToAcp({
			mcpConfig: {
				slack: {
					command: "npx",
					args: ["-y", "slack-mcp"],
					env: { SLACK_TOKEN: "xoxb" },
				} as any,
			},
		});

		expect(servers[0]).toMatchObject({
			name: "slack",
			command: "npx",
			args: ["-y", "slack-mcp"],
			env: [{ name: "SLACK_TOKEN", value: "xoxb" }],
		});
	});

	it("defaults stdio args to empty array", () => {
		const servers = translateMcpConfigToAcp({
			mcpConfig: {
				foo: { command: "/bin/foo" } as any,
			},
		});
		expect(servers[0]).toMatchObject({ args: [] });
	});

	it("skips HTTP when mcpCapabilities.http is false", () => {
		const servers = translateMcpConfigToAcp({
			mcpConfig: {
				linear: {
					type: "http",
					url: "https://mcp.linear.app/mcp",
					headers: {},
				} as any,
			},
			mcpCapabilities: { http: false },
		});
		expect(servers).toHaveLength(0);
	});

	it("skips HTTP when mcpCapabilities is undefined (ACP: not present = unsupported)", () => {
		const servers = translateMcpConfigToAcp({
			mcpConfig: {
				linear: {
					type: "http",
					url: "https://mcp.linear.app/mcp",
					headers: {},
				} as any,
			},
		});
		expect(servers).toHaveLength(0);
	});

	it("includes HTTP only when mcpCapabilities.http is true", () => {
		const servers = translateMcpConfigToAcp({
			mcpConfig: {
				linear: {
					type: "http",
					url: "https://mcp.linear.app/mcp",
					headers: { Authorization: "Bearer x" },
				} as any,
			},
			mcpCapabilities: { http: true },
		});
		expect(servers).toHaveLength(1);
		expect(servers[0]?.name).toBe("linear");
	});

	it("skips in-process SDK servers", () => {
		const servers = translateMcpConfigToAcp({
			mcpConfig: {
				local: {
					listTools: async () => [],
					callTool: async () => ({}),
				} as any,
			},
		});
		expect(servers).toHaveLength(0);
	});

	it("auto-loads worktree .mcp.json and merges with inline natives", () => {
		const dir = mkdtempSync(join(tmpdir(), "grok-mcp-merge-"));
		writeFileSync(
			join(dir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					context: { command: "context", args: ["serve"] },
					exa: {
						type: "http",
						url: "https://mcp.exa.ai/mcp",
						headers: { "x-api-key": "${EXA_API_KEY}" },
					},
				},
			}),
		);
		process.env.EXA_API_KEY = "test-exa-key";

		const servers = translateMcpConfigToAcp({
			workingDirectory: dir,
			mcpConfig: {
				linear: {
					type: "http",
					url: "https://mcp.linear.app/mcp",
					headers: {},
				} as any,
				"cyrus-tools": {
					type: "http",
					url: "http://127.0.0.1:3456/mcp/cyrus-tools",
					headers: {},
				} as any,
				"cyrus-docs": {
					type: "http",
					url: "https://atcyrus.com/docs/mcp",
					headers: {},
				} as any,
			},
			mcpCapabilities: { http: true },
		});

		const names = servers.map((s) => s.name).sort();
		expect(names).toEqual(
			["context", "cyrus-docs", "cyrus-tools", "exa", "linear"].sort(),
		);

		const exa = servers.find((s) => s.name === "exa");
		expect(exa).toMatchObject({ type: "http" });
		if (exa && "headers" in exa) {
			expect(exa.headers).toEqual([
				{ name: "x-api-key", value: "test-exa-key" },
			]);
		}

		const context = servers.find((s) => s.name === "context");
		expect(context).toMatchObject({
			name: "context",
			command: "context",
			args: ["serve"],
		});
	});

	it("recovers broken Edge absolute path and still loads worktree project servers", () => {
		const dir = mkdtempSync(join(tmpdir(), "grok-mcp-broken-path-"));
		writeFileSync(
			join(dir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					context: { command: "context", args: ["serve"] },
				},
			}),
		);

		const servers = translateMcpConfigToAcp({
			workingDirectory: dir,
			// What Edge resolvePath(".mcp.json") produces under systemd cwd=/
			mcpConfigPath: "/.mcp.json",
			mcpConfig: {
				linear: {
					type: "http",
					url: "https://mcp.linear.app/mcp",
					headers: {},
				} as any,
			},
			mcpCapabilities: { http: true },
		});

		const names = servers.map((s) => s.name);
		expect(names).toContain("context");
		expect(names).toContain("linear");
	});

	it("keeps HTTP gated when capability is false even with worktree project file", () => {
		const dir = mkdtempSync(join(tmpdir(), "grok-mcp-http-gate-"));
		writeFileSync(
			join(dir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					context: { command: "context", args: [] },
					exa: { type: "http", url: "https://mcp.exa.ai/mcp", headers: {} },
				},
			}),
		);

		const servers = translateMcpConfigToAcp({
			workingDirectory: dir,
			mcpConfig: {
				linear: {
					type: "http",
					url: "https://mcp.linear.app/mcp",
					headers: {},
				} as any,
			},
			mcpCapabilities: { http: false },
		});

		// Only stdio project server survives
		expect(servers.map((s) => s.name)).toEqual(["context"]);
	});
});
