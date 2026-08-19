import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveGrokHome } from "./backend/folderTrust.js";

/**
 * Resolve the Grok Build CLI binary path.
 * Order: explicit path → GROK_PATH → PATH `grok` → ~/.grok/bin/grok
 */
export function resolveGrokBinary(explicitPath?: string): string {
	if (explicitPath && explicitPath.trim().length > 0) {
		return explicitPath;
	}
	if (process.env.GROK_PATH && process.env.GROK_PATH.trim().length > 0) {
		return process.env.GROK_PATH;
	}
	const managed = join(resolveGrokHome(), "bin", "grok");
	if (existsSync(managed)) {
		return managed;
	}
	return "grok";
}

/** True when a Grok CLI login session file exists (does not read token contents). */
export function hasGrokCachedAuth(grokHome?: string): boolean {
	return existsSync(join(resolveGrokHome(grokHome), "auth.json"));
}
