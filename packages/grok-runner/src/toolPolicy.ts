/**
 * Translate Cyrus's Claude-shaped tool restrictions into Grok permission rules.
 *
 * Cyrus expresses tool policy in Claude Code's vocabulary (`Read(**)`,
 * `Bash(git:*)`, `mcp__linear`, plus presets like `readOnly`). Grok has its own
 * permission-rule system that is *deliberately* Claude-compatible, but not
 * identical, and the mismatches fail quietly:
 *
 *   - `mcp__server__tool` NEVER matches a Grok MCP call. Grok tool names carry
 *     no `mcp__` prefix; the rule has to be written `MCPTool(server__tool)`.
 *     Passed through verbatim, a review persona's `mcp__linear` silently grants
 *     nothing — and the reviewer can't post its findings back to Linear.
 *   - Rules naming a tool Grok doesn't know (`Task`, `Skill`, `TaskCreate`, …)
 *     are skipped with a warning rather than failing the load, so a policy can
 *     look applied while most of it evaporated.
 *
 * Enforcement uses **deny** rules rather than an allow-list, because only deny
 * is honoured in every permission mode: "always-approve mode short-circuits the
 * pipeline after step 2 — deny rules, hooks, and shell ask rules still apply".
 * An allow-list alone would be inert under the `--always-approve` the runner
 * passes for unattended sessions, and Grok's deny-by-default mode (`dontAsk`)
 * cannot be turned on from the CLI — `--permission-mode dontAsk` is accepted but
 * does not enable that policy; it needs `defaultMode` in `.claude/settings.json`,
 * which we will not write into the user's repository worktree.
 *
 * So: when an allow-list is in force, every mutating tool class *not* in it is
 * denied explicitly. That is the same shape as Grok's own documented read-only
 * reviewer example (allow read + grep, deny edit + bash). "In force" means the
 * operator configured a list — not that the list survived translation. Reading
 * it the other way turned a persona whose every rule had no Grok equivalent
 * into an unrestricted session; see the note on `restricted` below.
 *
 * ## Nothing the agent says decides anything
 *
 * The client-side half of this module (`evaluatePermissionRequest` onward)
 * exists because the Grok CLI did not honour its own deny rules. Having taken
 * the decision away from that process, it must not hand it back: a
 * self-declared `read_only` flag, a `__` in a free-text label, and a tool name
 * nobody has seen before are all treated as unproven rather than as safe. Each
 * of those three was a measured bypass before it was closed.
 *
 * Reference: the Grok CLI's bundled `docs/user-guide/22-permissions-and-safety.md`
 * ("Tool Names", "MCP Rules", "Example Configurations").
 */

import { commandMatchesAllowedBash, splitShellCommands } from "cyrus-core";

// The shell-command matching below used to live here. It is engine-agnostic —
// string matching over a shell command and a list of `Bash(...)` grants — and
// `ClaudeRunner` needs exactly the same behaviour to enforce the same grants
// through its `canUseTool` callback (CYR-20). It now lives in `cyrus-core` so
// both runners share one implementation; a command refused on Grok is refused
// on Claude. Re-exported here so this module's surface is unchanged.
export { splitShellCommands };

/**
 * Tool names Grok's rule parser recognizes. Anything else is dropped by Grok
 * with a warning, so we surface it instead of pretending it applied.
 */
const RECOGNIZED_TOOL_NAMES = new Set([
	"Bash",
	"Read",
	"NotebookRead",
	"Edit",
	"Write",
	"NotebookEdit",
	"Grep",
	"Glob",
	"MCPTool",
	"WebFetch",
	"WebSearch",
	"*",
]);

/**
 * Tool classes that can modify the workspace. When an allow-list omits one of
 * these, it is denied outright — this is what makes a `readOnly` preset real
 * rather than advisory.
 */
const MUTATING_TOOL_NAMES = ["Edit", "Write", "NotebookEdit", "Bash"] as const;

export interface GrokToolPolicy {
	/** `--allow` rules to pass to the Grok CLI. */
	allow: string[];
	/** `--deny` rules to pass to the Grok CLI. Enforced in every mode. */
	deny: string[];
	/** Input entries with no Grok equivalent; dropped, reported for logging. */
	untranslated: string[];
	/**
	 * True when the operator configured an allow-list at all.
	 *
	 * This is the operator's *intent*, read from the configured list rather than
	 * from what survived translation or from `deny.length`. Callers deciding
	 * whether to relax anything for an unattended session must gate on this:
	 * `deny.length === 0` used to stand in for it, and a policy whose every rule
	 * evaporated in translation therefore read as "no restriction configured".
	 */
	restricted: boolean;
	/**
	 * True when the allow-list scopes Bash to specific commands (e.g.
	 * `Bash(git:*)`). Grok evaluates deny before allow, so a blanket `Bash` deny
	 * would also kill the permitted commands, and the narrower "only these bash
	 * commands" policy is not expressible with rules alone — it needs `dontAsk`
	 * or a PreToolUse hook. No blanket deny is sent, and the caller says so;
	 * the scope itself is enforced client-side by `evaluatePermissionRequest`,
	 * which is not bound by that ordering.
	 */
	scopedBashUnenforceable: boolean;
}

/** Split `Name(args)` into its head and the parenthesised remainder. */
function splitRule(rule: string): { head: string; args?: string } {
	const match = rule.match(/^([A-Za-z*][A-Za-z0-9_]*)(\((.*)\))?$/s);
	if (!match?.[1]) {
		return { head: "" };
	}
	return { head: match[1], args: match[3] };
}

/**
 * Translate one Cyrus/Claude tool rule into its Grok equivalent.
 * Returns null when Grok has no equivalent.
 */
export function translateToolRule(rule: string): string | null {
	const trimmed = rule.trim();
	if (!trimmed) {
		return null;
	}

	// `mcp__server` / `mcp__server__tool` → `MCPTool(server__tool)`.
	// Cyrus grants a whole server (`mcp__linear`); Grok needs an explicit glob.
	const mcp = trimmed.match(/^mcp__([A-Za-z0-9_.-]+?)(?:__(.+))?$/);
	if (mcp?.[1]) {
		const server = mcp[1];
		const tool = mcp[2] ?? "*";
		return `MCPTool(${server}__${tool})`;
	}

	const { head } = splitRule(trimmed);
	if (head && RECOGNIZED_TOOL_NAMES.has(head)) {
		// Already Grok-compatible, including the `Bash(git:*)` prefix form.
		return trimmed;
	}

	return null;
}

/**
 * Build the Grok permission rules for a session from Cyrus's tool config.
 *
 * @param allowedTools Cyrus `allowedTools` (empty/undefined = unrestricted)
 * @param disallowedTools Cyrus `disallowedTools`
 */
export function translateToolRules(
	allowedTools?: string[],
	disallowedTools?: string[],
): GrokToolPolicy {
	const untranslated: string[] = [];
	const allow: string[] = [];
	const deny: string[] = [];

	for (const entry of allowedTools ?? []) {
		const translated = translateToolRule(entry);
		if (translated) {
			if (!allow.includes(translated)) {
				allow.push(translated);
			}
		} else if (entry.trim()) {
			untranslated.push(entry.trim());
		}
	}

	for (const entry of disallowedTools ?? []) {
		const translated = translateToolRule(entry);
		if (translated) {
			if (!deny.includes(translated)) {
				deny.push(translated);
			}
		} else if (entry.trim()) {
			untranslated.push(entry.trim());
		}
	}

	// No allow-list means "unrestricted" in Cyrus — only explicit denies apply.
	//
	// Derived from the *configured* list, not the translated one. `allow` counts
	// rules that survived translation, and translation drops everything Grok does
	// not know: a planning persona allowed `["Task","Skill","TaskCreate",
	// "TaskUpdate","ToolSearch"]` translates to nothing at all, so an
	// `allow.length > 0` test read that session as unrestricted, emitted no
	// denies, and — because `GrokRunner` gates `--always-approve` on an empty
	// deny list — also handed it back the blanket approval. An operator who
	// restricted a persona got a fully unrestricted one, with a warning line as
	// the only signal. That is precisely the failure this module's docblock names.
	//
	// An allow-list that translates to nothing must deny everything mutating,
	// not nothing.
	const configuredAllow = (allowedTools ?? [])
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	const restricted = configuredAllow.length > 0;
	let scopedBashUnenforceable = false;

	if (restricted) {
		const allowedHeads = new Set(
			allow.map((rule) => splitRule(rule).head).filter(Boolean),
		);
		// A scoped Bash grant (`Bash(git:*)`) cannot coexist with a blanket Bash
		// deny, because deny wins regardless of specificity.
		const bashRules = allow.filter((rule) => splitRule(rule).head === "Bash");
		scopedBashUnenforceable = bashRules.some((rule) => rule !== "Bash");

		for (const tool of MUTATING_TOOL_NAMES) {
			if (allowedHeads.has(tool) || allowedHeads.has("*")) {
				continue;
			}
			if (tool === "Bash" && scopedBashUnenforceable) {
				continue;
			}
			if (!deny.includes(tool)) {
				deny.push(tool);
			}
		}
	}

	return { allow, deny, untranslated, scopedBashUnenforceable, restricted };
}

/* -------------------------------------------------------------------------
 * Client-side enforcement of the policy, over ACP.
 *
 * Passing `--allow`/`--deny` to the CLI turned out NOT to be enough. Verified
 * live on CYR-9: the spawned process carried `--deny Write`, the agent wrote a
 * file anyway, and its ACP wire log for that session contained 746 updates and
 * **zero** `session/request_permission` requests — the write completed in 7ms
 * with no permission handshake at all. `--always-approve` (Grok's
 * `bypassPermissions`) short-circuits the rule engine before deny rules are
 * consulted, contrary to its documentation.
 *
 * So enforcement has to happen where ACP actually puts the decision: the
 * client. Two changes work together —
 *   1. the runner stops passing `--always-approve` when a restriction is in
 *      force, so the agent asks instead of proceeding silently, and
 *   2. the client answers those asks against the policy instead of
 *      blanket-approving them (`autoApprovePermission`).
 * ---------------------------------------------------------------------- */

/** Grok/ACP tool identifiers that mean "this call mutates the workspace". */
const MUTATING_TOOL_HINTS = new Set([
	// ACP ToolKind values
	"edit",
	"delete",
	"move",
	"execute",
	// Grok/opencode tool names seen on the wire
	"write",
	"search_replace",
	"str_replace",
	"str_replace_editor",
	"create_file",
	"apply_patch",
	"notebook_edit",
	"bash",
	"run_terminal_command",
	"run_command",
	"shell",
	"terminal",
]);

/**
 * Grok/ACP tool identifiers Cyrus recognises as incapable of mutating.
 *
 * This is the list that decides, not {@link MUTATING_TOOL_HINTS}. The two are
 * not symmetric and the asymmetry is the point:
 *
 * A name blocklist has to be complete to be worth anything, and this one cannot
 * be — measured, a tool called `str_replace_editor` sailed past it, and any
 * write tool Grok renames or adds does the same. So the verdict is inverted: a
 * hint on the mutating list is denied, a hint on *this* list is allowed, and a
 * call that matches neither is denied. That is what "a request we cannot
 * classify is denied" means, and it is what the module docblock always claimed.
 *
 * The cost is over-blocking a genuinely read-only tool Cyrus has not seen yet.
 * That is the failure we want: it appears in the session transcript as a
 * refusal, where an operator can read it and add the name here. The other
 * direction is a silent write.
 *
 * Note the ACP `kind` field would classify most calls correctly on its own, but
 * `describePermissionRequest` documents that shape as non-contractual — so it
 * is read as one hint among several rather than leaned on.
 */
const READ_ONLY_TOOL_HINTS = new Set([
	// ACP ToolKind values that cannot mutate
	"read",
	"search",
	"think",
	"fetch",
	// Grok/opencode tool names seen on the wire
	"ls",
	"list",
	"list_dir",
	"list_directory",
	"read_file",
	"view",
	"view_file",
	"cat",
	"grep",
	"glob",
	"grep_search",
	"file_search",
	"codebase_search",
	"semantic_search",
	"web_search",
	"web_fetch",
	"webfetch",
	"websearch",
	"todo_read",
	"todoread",
	"oracle",
	"thinking",
]);

/** Which rule name a mutating tool should be checked against. */
function ruleNamesForHint(hint: string): string[] {
	switch (hint) {
		case "execute":
		case "bash":
		case "run_terminal_command":
		case "run_command":
		case "shell":
			return ["Bash"];
		case "notebook_edit":
			return ["NotebookEdit", "Edit"];
		default:
			return ["Write", "Edit"];
	}
}

/**
 * Pull the identifying strings out of an ACP `session/request_permission`
 * payload. The shape is not contractual, so read every plausible field rather
 * than betting on one: Grok carries its own descriptor under
 * `_meta["x.ai/tool"]` (`{name, kind, label, read_only}`), while ACP proper
 * uses `toolCall.kind` and `toolCall.title`.
 */
export function describePermissionRequest(params: unknown): {
	hints: string[];
	/**
	 * Whether the *agent* declared this call read-only.
	 *
	 * Reported for logging only. It is deliberately not an input to
	 * {@link evaluatePermissionRequest}: see the note there.
	 */
	explicitlyReadOnly: boolean;
	mcpServer?: string;
	/** The shell command, when this is a Bash-class call. */
	command?: string;
} {
	const p = (params ?? {}) as Record<string, unknown>;
	const toolCall = (p.toolCall ?? p.tool_call ?? p) as Record<string, unknown>;
	const meta = (toolCall._meta ?? {}) as Record<string, unknown>;
	const xai = (meta["x.ai/tool"] ?? {}) as Record<string, unknown>;

	const raw = [
		xai.name,
		xai.kind,
		xai.label,
		toolCall.kind,
		toolCall.title,
		toolCall.name,
	].filter((v): v is string => typeof v === "string" && v.length > 0);

	const hints = raw.map((s) => s.toLowerCase());

	// An MCP tool call is named `server__tool`; the rule form is MCPTool(...).
	//
	// Matched against the *name* fields only. Matching every raw string meant a
	// `label` or `title` containing `__` routed the call into the MCP branch,
	// which allows unless the server is denied: measured, a tool named
	// `search__replace` with kind `edit` came back allowed, on the strength of a
	// server called "search" that does not exist. `search_replace` is on the
	// mutating list — one extra underscore skipped every mutation check.
	//
	// A name that is itself a known mutating tool is never read as an MCP call,
	// so a tool named `apply__patch` cannot launder itself either.
	let mcpServer: string | undefined;
	const nameFields = [xai.name, toolCall.name].filter(
		(v): v is string => typeof v === "string" && v.length > 0,
	);
	for (const value of nameFields) {
		if (MUTATING_TOOL_HINTS.has(value.toLowerCase())) continue;
		const match = value.match(/^([A-Za-z0-9_.-]+?)__[A-Za-z0-9_.-]+$/);
		if (match?.[1]) {
			mcpServer = match[1];
			break;
		}
	}

	const rawInput = (toolCall.rawInput ?? toolCall.raw_input ?? {}) as Record<
		string,
		unknown
	>;
	const commandValue =
		rawInput.command ?? rawInput.cmd ?? rawInput.script ?? rawInput.input;

	return {
		hints,
		explicitlyReadOnly: xai.read_only === true || toolCall.read_only === true,
		mcpServer,
		command: typeof commandValue === "string" ? commandValue : undefined,
	};
}

/**
 * Decide whether a permission request may proceed under the policy.
 *
 * Fails **closed**: with a restriction in force, a request we cannot classify
 * is denied. A guardrail that quietly allows the calls it does not recognise is
 * not a guardrail — and over-blocking surfaces loudly in the session transcript,
 * where it can be fixed, rather than silently letting a write through.
 *
 * ## Everything the agent says is treated as hostile
 *
 * This module exists because the Grok CLI did not honour its own deny rules.
 * Enforcement moved to the client precisely so the decision stops depending on
 * that process — so nothing the agent asserts about a call can be the reason it
 * is permitted:
 *
 * - `_meta["x.ai/tool"].read_only` is **not** consulted. It used to
 *   short-circuit ahead of the deny rules, and it was set by the same process
 *   being restricted. Measured, for a `readOnly` persona denying `Write`: an
 *   honest write was refused, and the identical write with `read_only: true`
 *   was allowed. One self-declared flag, opposite verdicts. A tool is treated
 *   as read-only only when its *name or kind* is on a list Cyrus controls
 *   ({@link READ_ONLY_TOOL_HINTS}).
 * - A `server__tool` shape is read from the name fields only, never from a
 *   free-text label, and never when the name is a known mutating tool.
 * - The mutating check runs **before** the MCP branch, so no naming trick
 *   routes a write around it.
 */
export function evaluatePermissionRequest(
	params: unknown,
	policy: Pick<GrokToolPolicy, "deny"> & Partial<Pick<GrokToolPolicy, "allow">>,
): { allowed: boolean; reason: string } {
	if (policy.deny.length === 0) {
		return { allowed: true, reason: "no restriction in force" };
	}

	const { hints, mcpServer, command } = describePermissionRequest(params);
	const allow = policy.allow ?? [];

	// A deny rule with no argument (`Write`, `Bash`) denies the whole tool
	// class. A *scoped* rule (`Bash(sed:*)`) denies only the commands it names
	// and must not be read as a blanket deny — doing so refuses the very
	// commands the allow-list grants. That is not hypothetical: once CYR-25
	// started deriving scoped `Bash(...)` denies, reading their head as a
	// blanket "Bash" made a readOnly persona refuse its own
	// `Bash(git -C * pull)` grant, i.e. every shell command it had.
	const blanketDenied = new Set(
		policy.deny
			.filter((rule) => splitRule(rule).args === undefined)
			.map((rule) => splitRule(rule).head),
	);
	const scopedBashDenies = policy.deny.filter((rule) => {
		const { head, args } = splitRule(rule);
		return head === "Bash" && args !== undefined;
	});

	// The mutating check runs first, and the *first* mutating hint decides. That
	// was already true — every branch below returned — but the `for` shape read
	// as though it checked all of them, so a future edit that dropped a `return`
	// would change behaviour silently. Stating it as a `find` makes the rule
	// visible: order of `raw` in `describePermissionRequest` decides.
	const mutatingHint = hints.find((hint) => MUTATING_TOOL_HINTS.has(hint));

	if (mutatingHint) {
		const hint = mutatingHint;
		for (const ruleName of ruleNamesForHint(hint)) {
			if (blanketDenied.has(ruleName)) {
				return { allowed: false, reason: `${ruleName} is denied (${hint})` };
			}
		}

		// Scoped shell denies are matched against the command itself, per link
		// of a chain, so `git pull && sed -i …` is refused on the strength of
		// the `sed` rule while a bare `git pull` still runs. Deny is checked
		// before the allow-list so it wins, matching the Claude path where the
		// SDK evaluates deny rules ahead of everything else.
		if (
			ruleNamesForHint(hint).includes("Bash") &&
			scopedBashDenies.length > 0
		) {
			if (!command) {
				return {
					allowed: false,
					reason: "shell call with no readable command (fail closed)",
				};
			}
			// `null` means the command could not be parsed into links. Fail
			// closed: an unparseable command is exactly where a deny rule would
			// be evaded.
			const links = splitShellCommands(command);
			if (links === null) {
				return {
					allowed: false,
					reason: "shell command could not be parsed (fail closed)",
				};
			}
			for (const link of links) {
				const matched = scopedBashDenies.find((rule) =>
					commandMatchesAllowedBash(link, [rule]),
				);
				if (matched) {
					return {
						allowed: false,
						reason: `shell command is denied by ${matched}: ${link.slice(0, 80)}`,
					};
				}
			}
		}

		// Shell is the escape hatch that makes every other deny cosmetic: a
		// session denied `Edit` can still edit in place through `sed -i`, commit
		// by pointing git at another directory, or merge through the GitHub API.
		// A scoped grant like `Bash(git diff:*)` is meant to permit *only* those
		// commands, so anything outside the grant is refused — deny rules alone
		// cannot express that, because deny beats allow in the rule engine.
		if (ruleNamesForHint(hint).includes("Bash") && allow.length > 0) {
			if (!command) {
				return {
					allowed: false,
					reason: "shell call with no readable command (fail closed)",
				};
			}
			if (!commandMatchesAllowedBash(command, allow)) {
				return {
					allowed: false,
					reason: `shell command is outside the allow-list: ${command.slice(0, 80)}`,
				};
			}
			return { allowed: true, reason: "shell command matches the allow-list" };
		}

		// A mutating tool we recognise, whose class is not denied.
		return { allowed: true, reason: `${hint} is not denied` };
	}

	// MCP calls are checked *after* the mutating hints, so a `server__tool`
	// shape can no longer be used to skip them.
	if (mcpServer) {
		const blocked = policy.deny.some((rule) => {
			const { head, args } = splitRule(rule);
			if (head !== "MCPTool" || !args) return false;
			const server = args.split("__")[0];
			return server === "*" || server === mcpServer;
		});
		return blocked
			? { allowed: false, reason: `MCP server '${mcpServer}' is denied` }
			: { allowed: true, reason: `MCP server '${mcpServer}' is not denied` };
	}

	if (hints.length === 0) {
		return { allowed: false, reason: "unidentifiable tool call (fail closed)" };
	}

	// Not mutating, not MCP: allowed only if Cyrus recognises it as read-only.
	// Anything else is a name we have never seen, and the whole reason this
	// module exists is that a name we have never seen may well be a write —
	// `str_replace_editor` was allowed by the old "no mutating signal" rule.
	const readOnlyHint = hints.find((hint) => READ_ONLY_TOOL_HINTS.has(hint));
	if (readOnlyHint) {
		return {
			allowed: true,
			reason: `recognised read-only tool (${readOnlyHint})`,
		};
	}

	return {
		allowed: false,
		reason: `unclassified tool call, denied (fail closed): [${hints.join(", ")}]`,
	};
}

/**
 * Build the ACP response that refuses a permission request, preferring an
 * explicit reject option when the agent offers one and falling back to
 * cancelling the call.
 *
 * `kind` is checked across **all** options before any name is considered, and
 * an option whose `kind` says allow is never selectable. The previous version
 * used one `find` over a predicate that included a bare `name.includes("no")`,
 * and `find` takes the first option matching *anything*: given
 * `[{kind:"allow_once", name:"Allow now"}, {kind:"reject_once", name:"Reject"}]`
 * it selected the allow option, because "Allow now" contains "no". A denial that
 * returns an approval is worse than no enforcement, because it reads as
 * enforcement in the log.
 */
export function buildRejectionOutcome(params: unknown): unknown {
	const p = (params ?? {}) as {
		options?: Array<{
			optionId?: string;
			option_id?: string;
			kind?: string;
			name?: string;
		}>;
	};
	const options = Array.isArray(p.options) ? p.options : [];

	const kindOf = (o: { kind?: string }) => (o.kind || "").toLowerCase();
	const isAllowKind = (o: { kind?: string }) => {
		const kind = kindOf(o);
		return kind.startsWith("allow") || kind === "approve" || kind === "accept";
	};

	// 1. A contractual reject kind, anywhere in the list.
	const byKind = options.find((o) => {
		const kind = kindOf(o);
		return kind.startsWith("reject") || kind === "deny" || kind === "cancel";
	});

	// 2. Only if no option carries a usable kind, fall back to the label — and
	//    never to a label on an option that declares itself an approval. Whole
	//    words only: "no" as a substring matches "Allow now".
	const byName = options.some((o) => kindOf(o).length > 0)
		? undefined
		: options.find((o) => {
				if (isAllowKind(o)) return false;
				const name = (o.name || "").toLowerCase();
				return /\b(reject|deny|decline|refuse|no|never)\b/.test(name);
			});

	const reject = byKind ?? byName;
	const optionId = reject?.optionId || reject?.option_id;
	if (optionId) {
		return { outcome: { outcome: "selected", optionId } };
	}
	// No usable reject option: cancelling the call is the refusal.
	return { outcome: { outcome: "cancelled" } };
}
