import type { CyrusAgentSession, ILogger, RepositoryConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	type IChatToolResolver,
	type IMcpConfigProvider,
	type IRunnerSelector,
	RunnerConfigBuilder,
} from "../src/RunnerConfigBuilder.js";

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

function makeBuilder(): RunnerConfigBuilder {
	const chatToolResolver: IChatToolResolver = {
		buildChatAllowedTools: () => ["Read(**)"],
	};
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: () => ({}),
		buildMergedMcpConfigPath: () => undefined,
	};
	const runnerSelector: IRunnerSelector = {
		determineRunnerSelection: () => ({ runnerType: "grok" as const }),
		getDefaultModelForRunner: () => "default",
		getDefaultFallbackModelForRunner: () => "default",
	};
	return new RunnerConfigBuilder(
		chatToolResolver,
		mcpConfigProvider,
		runnerSelector,
	);
}

describe("RunnerConfigBuilder Grok managed skills", () => {
	it("passes scoped plugins and skill names to Grok runner configs", () => {
		const session = {
			issueId: "issue-1",
			issue: { identifier: "BAR-47" },
			workspace: {
				path: "/ws/repo-a",
				isGitWorktree: true,
			},
		} as unknown as CyrusAgentSession;
		const repository = {
			id: "repo-a",
			name: "Repo A",
			repositoryPath: "/repos/repo-a",
			allowedTools: [],
		} as unknown as RepositoryConfig;
		const plugins = [
			{ type: "local" as const, path: "/cyrus/user-skills" },
			{ type: "local" as const, path: "/cyrus/cyrus-skills" },
		];

		const { config, runnerType } = makeBuilder().buildIssueConfig({
			session,
			repository,
			sessionId: "sess-1",
			systemPrompt: "test",
			allowedTools: ["Read(**)"],
			allowedDirectories: ["/repos/repo-a"],
			disallowedTools: [],
			cyrusHome: "/tmp/cyrus-home",
			linearWorkspaceId: "ws-1",
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
			requireLinearWorkspaceId: () => "ws-1",
			plugins,
			skills: ["verify-and-ship", "implementation", "summarize"],
		});

		expect(runnerType).toBe("grok");
		expect(config.plugins).toEqual(plugins);
		expect(config.skills).toEqual([
			"verify-and-ship",
			"implementation",
			"summarize",
		]);
	});
});
