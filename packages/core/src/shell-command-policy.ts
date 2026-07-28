/**
 * Engine-agnostic matching of shell commands against Claude-shaped scoped Bash
 * grants (`Bash(git diff:*)`).
 *
 * These primitives were written for the Grok runner (CYR-17), where the ACP
 * permission handshake is answered client-side. They turned out to be needed
 * verbatim on the Claude path too (CYR-20): a `readOnly` Claude persona carries
 * the same `Bash(git diff:*)`-shaped grants, and enforcing them in
 * `ClaudeRunner`'s `canUseTool` callback needs exactly this matching. Nothing
 * here is specific to either engine — it is string matching over a shell
 * command and a list of grant patterns — so it lives in `cyrus-core` and both
 * runners import it. `cyrus-claude-runner` does not (and should not) depend on
 * `cyrus-grok-runner`.
 *
 * The two runners must agree: a command refused on Grok has to be refused on
 * Claude, or the choice of engine silently changes the security posture.
 */

/** Split `Name(args)` into its head and the parenthesised remainder. */
function splitRule(rule: string): { head: string; args?: string } {
	const match = rule.match(/^([A-Za-z*][A-Za-z0-9_]*)(\((.*)\))?$/s);
	if (!match?.[1]) {
		return { head: "" };
	}
	return { head: match[1], args: match[3] };
}

/**
 * Split a shell command into the individual commands it will actually run.
 *
 * Matching a grant against the raw string only ever examines the *first*
 * command: under `Bash(git diff:*)`, `git diff HEAD && sed -i s/a/b/ f` reads as
 * an allowed `git diff` — the very in-place-edit escape this policy exists to
 * close, caught only when it happens to be the first word. So every command has
 * to be checked, which means every command has to be found first: the operators
 * `;` `&&` `||` `|` `&` and newlines separate them, and `$(…)`/backticks hide
 * more of them inside an otherwise-innocent argument.
 *
 * Quote-aware, because an operator inside quotes is data, not a separator.
 * Returns null when the command cannot be parsed — an unterminated quote or
 * substitution — so the caller can fail closed rather than guess.
 */
export function splitShellCommands(command: string): string[] | null {
	const segments: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;

	const flush = () => {
		const trimmed = current.trim();
		if (trimmed) segments.push(trimmed);
		current = "";
	};

	/** Index of the `)` closing the `(` at `open`, or -1. */
	const findClose = (open: number): number => {
		let depth = 0;
		for (let j = open; j < command.length; j++) {
			if (command[j] === "(") depth++;
			else if (command[j] === ")" && --depth === 0) return j;
		}
		return -1;
	};

	for (let i = 0; i < command.length; i++) {
		const char = command[i] as string;
		const next = command[i + 1];

		// An escaped character is data, never an operator or a quote.
		if (char === "\\" && quote !== "'") {
			if (i + 1 >= command.length) return null;
			current += char + next;
			i++;
			continue;
		}

		// Command substitution runs everywhere except inside single quotes.
		if (quote !== "'" && (char === "`" || (char === "$" && next === "("))) {
			const inner =
				char === "`"
					? (() => {
							const end = command.indexOf("`", i + 1);
							return end === -1
								? null
								: { body: command.slice(i + 1, end), end };
						})()
					: (() => {
							const end = findClose(i + 1);
							return end === -1
								? null
								: { body: command.slice(i + 2, end), end };
						})();
			if (!inner) return null;
			const nested = splitShellCommands(inner.body);
			if (nested === null) return null;
			segments.push(...nested);
			// The substitution's *value* is an argument to the outer command.
			current += " ";
			i = inner.end;
			continue;
		}

		if (quote) {
			if (char === quote) quote = null;
			current += char;
			continue;
		}

		if (char === "'" || char === '"') {
			quote = char;
			current += char;
			continue;
		}

		if (char === "\n" || char === ";") {
			flush();
			continue;
		}
		if ((char === "&" || char === "|") && next === char) {
			flush();
			i++;
			continue;
		}
		if (char === "|") {
			flush();
			continue;
		}
		if (char === "&") {
			// `2>&1` and `&>file` are redirections, not a background operator.
			if (command[i - 1] === ">" || next === ">") {
				current += char;
				continue;
			}
			flush();
			continue;
		}

		current += char;
	}

	if (quote) return null; // unterminated quote
	flush();
	return segments;
}

const REGEXP_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/**
 * Compile a scoped Bash grant's argument into a matcher.
 *
 * `Bash(git diff:*)` and `Bash(git diff *)` are prefix grants — Claude's `:*`
 * suffix and a trailing `*` both read as "…and any arguments". A `*` anywhere
 * *else* is a wildcard standing in for one argument, which is exactly the form
 * the shipped Slack preset uses: `Bash(git -C * pull)`. Stripping only the
 * suffix and then comparing literally left that `*` as a real asterisk, so the
 * grant matched nothing at all — not even the command it names.
 *
 * Returns "match-all" for a grant that permits every command (`Bash(*)`).
 */
export function compileBashPattern(args: string): RegExp | "match-all" {
	let pattern = args.trim().replace(/\*{2,}/g, "*");
	let prefix = false;
	if (pattern.endsWith(":*")) {
		pattern = pattern.slice(0, -2).trim();
		prefix = true;
	} else if (pattern.endsWith("*")) {
		pattern = pattern.slice(0, -1).trim();
		prefix = true;
	}
	if (!pattern) return "match-all";

	const body = pattern
		.split("*")
		.map((literal) => literal.replace(REGEXP_SPECIALS, "\\$&"))
		.join("\\S*");
	return new RegExp(prefix ? `^${body}(?:\\s[\\s\\S]*)?$` : `^${body}$`);
}

/**
 * Does a shell command match the allow-list's scoped Bash grants?
 *
 * Every command the string would run must be named by a grant — a chain is only
 * as permitted as its least-permitted link.
 *
 * @param allow Tool rules in Claude's vocabulary. Non-`Bash` entries are
 * ignored, so the caller can pass a whole `allowedTools` list.
 */
export function commandMatchesAllowedBash(
	command: string,
	allow: readonly string[],
): boolean {
	const matchers: RegExp[] = [];
	for (const rule of allow) {
		const { head, args } = splitRule(rule.trim());
		if (head !== "Bash") continue;
		// A bare `Bash` grant permits everything, chains included.
		if (!args) return true;
		const compiled = compileBashPattern(args);
		if (compiled === "match-all") return true;
		matchers.push(compiled);
	}
	if (matchers.length === 0) return false;

	const segments = splitShellCommands(command);
	// Unparseable, or nothing recognisable to run: we cannot say what this
	// would do, so we refuse it.
	if (segments === null || segments.length === 0) return false;
	return segments.every((segment) =>
		matchers.some((matcher) => matcher.test(segment)),
	);
}

/**
 * Does this allow-list grant `Bash` without narrowing it?
 *
 * A bare `Bash` (or `Bash(*)` / `Bash(**)`) is the unrestricted builder shape:
 * every command is permitted, so there is nothing to enforce.
 */
export function grantsUnrestrictedBash(allow: readonly string[]): boolean {
	return allow.some((rule) => {
		const { head, args } = splitRule(rule.trim());
		if (head !== "Bash") return false;
		if (args === undefined) return true;
		return compileBashPattern(args) === "match-all";
	});
}

/** Does this allow-list contain any `Bash(...)` grant at all? */
export function hasBashGrant(allow: readonly string[]): boolean {
	return allow.some((rule) => splitRule(rule.trim()).head === "Bash");
}
