import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

/** Filename under GROK_HOME — matches Grok Build's TrustStore. */
export const TRUST_FILE_NAME = "trusted_folders.toml";

/**
 * Resolve GROK_HOME the same way GrokRunner / Grok CLI do:
 * config.grokHome → process.env.GROK_HOME → ~/.grok
 */
export function resolveGrokHome(override?: string): string {
	return resolve(override || process.env.GROK_HOME || join(homedir(), ".grok"));
}

export function trustStorePath(grokHome?: string): string {
	return join(resolveGrokHome(grokHome), TRUST_FILE_NAME);
}

/**
 * Collect absolute paths that should be marked trusted so Grok's folder-trust
 * gate allows project-scoped MCP (names from worktree `.mcp.json`).
 *
 * Grok's `workspace_key(cwd)` collapses git worktrees onto the main workdir
 * of the common repository. Cyrus sessions use worktrees under
 * `~/.cyrus/worktrees/<id>` whose common dir is `~/.cyrus/repos/<name>`.
 * Trusting only the human clone path (e.g. `~/bartbuddy`) does not cover those.
 *
 * We record:
 * 1. The session workspace (cwd) itself
 * 2. The main repository workdir when `cwd` is a linked git worktree
 * 3. The git toplevel when discoverable and different
 */
export function collectFolderTrustPaths(workspace: string): string[] {
	const abs = resolve(workspace);
	const roots = new Set<string>();
	roots.add(abs);

	const gitMarker = join(abs, ".git");
	if (!existsSync(gitMarker)) {
		return [...roots];
	}

	try {
		const st = statSync(gitMarker);
		if (st.isDirectory()) {
			// Normal checkout: workspace is already the workdir.
			return [...roots];
		}

		// Linked worktree: `.git` is a file `gitdir: <common>/.git/worktrees/<name>`
		const text = readFileSync(gitMarker, "utf8");
		const match = text.match(/^gitdir:\s*(.+)\s*$/m);
		if (!match?.[1]) {
			return [...roots];
		}

		const gitdir = resolve(match[1].trim());
		const parts = gitdir.split(sep);
		const wtIdx = parts.lastIndexOf("worktrees");
		if (wtIdx > 0) {
			// .../<repo>/.git/worktrees/<name> → main workdir is .../<repo>
			const commonGit = parts.slice(0, wtIdx).join(sep); // .../<repo>/.git
			const mainWorkdir = dirname(commonGit);
			if (mainWorkdir && mainWorkdir !== sep) {
				roots.add(resolve(mainWorkdir));
			}
		}
	} catch {
		// Best-effort: still trust the workspace path alone.
	}

	return [...roots];
}

/**
 * Parse folder trust records from Grok's `trusted_folders.toml`.
 * Shape:
 * ```toml
 * [folders."/abs/path"]
 * trusted = true
 * decided_at = 1780000000
 * ```
 */
export function parseTrustedFoldersToml(
	content: string,
): Map<string, { trusted: boolean; decided_at?: number }> {
	const out = new Map<string, { trusted: boolean; decided_at?: number }>();
	let current: string | null = null;
	let trusted: boolean | undefined;
	let decidedAt: number | undefined;

	const flush = () => {
		if (current !== null && trusted !== undefined) {
			out.set(current, {
				trusted,
				...(decidedAt !== undefined ? { decided_at: decidedAt } : {}),
			});
		}
		current = null;
		trusted = undefined;
		decidedAt = undefined;
	};

	for (const raw of content.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;

		const section = line.match(/^\[folders\."((?:\\.|[^"\\])*)"\]$/);
		if (section?.[1] !== undefined) {
			flush();
			current = section[1].replace(/\\"/g, '"');
			continue;
		}

		if (current === null) continue;

		const trustedMatch = line.match(/^trusted\s*=\s*(true|false)\s*$/i);
		if (trustedMatch?.[1] !== undefined) {
			trusted = trustedMatch[1].toLowerCase() === "true";
			continue;
		}

		const decidedMatch = line.match(/^decided_at\s*=\s*(-?\d+)\s*$/);
		if (decidedMatch?.[1] !== undefined) {
			decidedAt = Number(decidedMatch[1]);
		}
	}
	flush();
	return out;
}

/**
 * Longest-prefix cascade (same semantics as Grok TrustStore::is_trusted).
 * Over-broad roots (/ and home) are ignored.
 */
export function isPathTrusted(
	folders: Map<string, { trusted: boolean }>,
	queryPath: string,
	home: string = homedir(),
): boolean {
	const key = resolve(queryPath);
	const homeAbs = resolve(home);
	let bestDepth = -1;
	let trusted = false;

	for (const [folder, record] of folders) {
		const f = resolve(folder);
		if (f === sep || f === homeAbs) continue;
		const isPrefix =
			key === f || key.startsWith(f.endsWith(sep) ? f : `${f}${sep}`);
		if (!isPrefix) continue;

		const depth = f.split(sep).filter(Boolean).length;
		if (depth > bestDepth) {
			bestDepth = depth;
			trusted = record.trusted;
		} else if (depth === bestDepth) {
			trusted = trusted && record.trusted;
		}
	}
	return trusted;
}

function serializeTrustedFoldersToml(
	folders: Map<string, { trusted: boolean; decided_at?: number }>,
): string {
	const lines: string[] = [];
	// Stable order for diffs / tests
	const keys = [...folders.keys()].sort();
	for (const path of keys) {
		const rec = folders.get(path);
		if (!rec) continue;
		// Escape backslashes and quotes in the TOML key string
		const escaped = path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		lines.push(`[folders."${escaped}"]`);
		lines.push(`trusted = ${rec.trusted ? "true" : "false"}`);
		if (rec.decided_at !== undefined) {
			lines.push(`decided_at = ${rec.decided_at}`);
		}
		lines.push("");
	}
	return lines.join("\n");
}

export interface EnsureFolderTrustOptions {
	/** Override GROK_HOME (default: env / ~/.grok) */
	grokHome?: string;
	/** Override full path to trusted_folders.toml (tests) */
	storePath?: string;
	/** Unix seconds for decided_at (tests); default: now */
	decidedAt?: number;
}

export interface EnsureFolderTrustResult {
	/** Paths that are trusted after this call */
	trustedPaths: string[];
	/** Paths newly written (or flipped to trusted) */
	writtenPaths: string[];
	storePath: string;
}

/**
 * Ensure every candidate workspace path is recorded as trusted in Grok's
 * folder-trust store so project MCP servers from `.mcp.json` are not dropped
 * when Cyrus runs `grok agent` headlessly (no interactive trust prompt).
 *
 * Idempotent: existing trusted=true entries are left alone; untrusted entries
 * for the same path are flipped to trusted (Cyrus owns these session worktrees).
 */
export function ensureGrokFolderTrust(
	workspace: string,
	options: EnsureFolderTrustOptions = {},
): EnsureFolderTrustResult {
	const store = options.storePath ?? trustStorePath(options.grokHome);
	const candidates = collectFolderTrustPaths(workspace);
	const decidedAt = options.decidedAt ?? Math.floor(Date.now() / 1000);

	let folders = new Map<string, { trusted: boolean; decided_at?: number }>();
	if (existsSync(store)) {
		try {
			folders = parseTrustedFoldersToml(readFileSync(store, "utf8"));
		} catch {
			folders = new Map();
		}
	}

	const writtenPaths: string[] = [];
	for (const path of candidates) {
		const abs = resolve(path);
		// Refuse over-broad roots (match Grok)
		if (abs === sep || abs === resolve(homedir())) {
			continue;
		}
		const existing = folders.get(abs);
		if (existing?.trusted === true) {
			continue;
		}
		folders.set(abs, { trusted: true, decided_at: decidedAt });
		writtenPaths.push(abs);
	}

	if (writtenPaths.length > 0) {
		const dir = dirname(store);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		const body = serializeTrustedFoldersToml(folders);
		const tmp = `${store}.${process.pid}.${Date.now()}.tmp`;
		writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
		renameSync(tmp, store);
	}

	const trustedPaths = candidates
		.map((p) => resolve(p))
		.filter((p) => isPathTrusted(folders, p));

	return { trustedPaths, writtenPaths, storePath: store };
}
