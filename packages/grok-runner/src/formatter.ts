import type { IMessageFormatter } from "cyrus-core";

type ToolInput = Record<string, unknown>;

function safeStringify(input: unknown): string {
	try {
		return JSON.stringify(input);
	} catch {
		return String(input);
	}
}

function asObject(input: unknown): ToolInput | null {
	if (input && typeof input === "object") {
		return input as ToolInput;
	}
	return null;
}

function truncateResult(result: string, maxLength = 4000): string {
	if (result.length <= maxLength) {
		return result;
	}
	return `${result.slice(0, maxLength)}\n\n[truncated]`;
}

/**
 * Formats Grok Build tool activity for Linear agent timelines.
 */
export class GrokMessageFormatter implements IMessageFormatter {
	formatTodoWriteParameter(jsonContent: string): string {
		try {
			const parsed = JSON.parse(jsonContent);
			if (!parsed || !Array.isArray(parsed.todos)) {
				return jsonContent;
			}

			const lines = parsed.todos.map((todo: Record<string, unknown>) => {
				const status =
					typeof todo.status === "string"
						? todo.status.toLowerCase()
						: "pending";
				const content =
					typeof todo.content === "string"
						? todo.content
						: typeof todo.description === "string"
							? todo.description
							: "";
				const marker = status === "completed" ? "[x]" : "[ ]";
				const suffix = status === "in_progress" ? " (in progress)" : "";
				return `- ${marker} ${content}${suffix}`.trim();
			});

			return lines.join("\n");
		} catch {
			return jsonContent;
		}
	}

	formatTaskParameter(toolName: string, toolInput: unknown): string {
		if (typeof toolInput === "string") {
			return toolInput;
		}
		const input = asObject(toolInput);
		if (!input) {
			return safeStringify(toolInput);
		}
		if (toolName === "TaskList") return "List all tasks";
		const taskId = typeof input.taskId === "string" ? input.taskId : "";
		const subject = typeof input.subject === "string" ? input.subject : "";
		if (toolName === "TaskCreate") return subject || "Create task";
		if (toolName === "TaskGet" && taskId) {
			return subject ? `Task #${taskId}: ${subject}` : `Task #${taskId}`;
		}
		return safeStringify(toolInput);
	}

	formatToolParameter(_toolName: string, toolInput: unknown): string {
		if (typeof toolInput === "string") {
			return toolInput;
		}
		const input = asObject(toolInput);
		if (!input) {
			return safeStringify(toolInput);
		}

		if (typeof input.command === "string") {
			return input.command;
		}
		if (typeof input.file_path === "string") {
			return input.file_path;
		}
		if (typeof input.path === "string") {
			return input.path;
		}
		if (typeof input.target_file === "string") {
			return input.target_file;
		}
		if (typeof input.target_directory === "string") {
			return input.target_directory;
		}
		if (typeof input.pattern === "string") {
			return input.pattern;
		}
		if (typeof input.url === "string") {
			return input.url;
		}

		return safeStringify(toolInput);
	}

	formatToolActionName(
		toolName: string,
		toolInput: unknown,
		_isError: boolean,
	): string {
		const input = asObject(toolInput);
		const description =
			input && typeof input.description === "string"
				? input.description.trim()
				: "";
		if (description) {
			return `${toolName} (${description})`;
		}
		return toolName;
	}

	formatToolResult(
		_toolName: string,
		_toolInput: unknown,
		result: string,
		isError: boolean,
	): string {
		const normalized = truncateResult(result || "No output");
		if (isError) {
			return `\`\`\`\n${normalized}\n\`\`\``;
		}
		return normalized;
	}
}
