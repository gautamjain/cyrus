/**
 * If the session ended with an error result, return a reply body that includes
 * the failure details. Otherwise return null so callers keep their existing
 * success-path summary logic unchanged.
 */
export function getSessionErrorReply(
	messages: readonly unknown[],
): string | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!isRecord(message) || message.type !== "result") {
			continue;
		}

		const isError =
			message.is_error === true ||
			(typeof message.subtype === "string" &&
				message.subtype.startsWith("error"));
		if (!isError) {
			return null;
		}

		const errors = normalizeErrors(message.errors);
		if (errors.length > 0) {
			const body =
				errors.length === 1
					? errors[0]!
					: errors.map((e) => `- ${e}`).join("\n");
			return `**Task failed**\n\n${body}`;
		}
		if (typeof message.subtype === "string" && message.subtype.length > 0) {
			return `**Task failed**\n\nSession ended with status: \`${message.subtype}\``;
		}
		return "**Task failed**";
	}
	return null;
}

function normalizeErrors(errors: unknown): string[] {
	if (!Array.isArray(errors)) {
		return [];
	}
	return errors
		.map((e) => (typeof e === "string" ? e : e != null ? String(e) : ""))
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
