import { describe, expect, it, vi } from "vitest";
import { normalizeTimeoutOptions } from "../src/backend/AcpClient.js";

describe("normalizeTimeoutOptions", () => {
	it("treats a bare number as wall-clock only (legacy API)", () => {
		expect(normalizeTimeoutOptions(60_000, 120_000)).toEqual({
			timeoutMs: 60_000,
			idleTimeoutMs: 0,
		});
	});

	it("uses client default wall-clock when options omit timeoutMs", () => {
		expect(normalizeTimeoutOptions({}, 60_000)).toEqual({
			timeoutMs: 60_000,
			idleTimeoutMs: 0,
		});
	});

	it("allows timeoutMs 0 (no wall-clock) with idle watchdog", () => {
		expect(
			normalizeTimeoutOptions(
				{ timeoutMs: 0, idleTimeoutMs: 300_000 },
				120_000,
			),
		).toEqual({
			timeoutMs: 0,
			idleTimeoutMs: 300_000,
		});
	});

	it("falls back to 120s wall-clock when nothing is configured", () => {
		expect(normalizeTimeoutOptions(undefined, undefined)).toEqual({
			timeoutMs: 120_000,
			idleTimeoutMs: 0,
		});
	});
});

describe("idle timeout semantics (documented contract)", () => {
	it("matches Codex default of 5 minutes for turn idle", async () => {
		const { GROK_DEFAULT_TURN_IDLE_TIMEOUT_MS } = await import(
			"../src/types.js"
		);
		expect(GROK_DEFAULT_TURN_IDLE_TIMEOUT_MS).toBe(300_000);
	});

	it("idle timer can be re-armed after activity (fake timers)", () => {
		vi.useFakeTimers();
		try {
			let fired = 0;
			const idleMs = 5_000;
			let timer: ReturnType<typeof setTimeout> | null = null;

			const arm = () => {
				if (timer) clearTimeout(timer);
				timer = setTimeout(() => {
					fired += 1;
				}, idleMs);
			};

			arm();
			vi.advanceTimersByTime(4_000);
			// Activity before deadline re-arms — same as AcpClient.touchActivity
			arm();
			vi.advanceTimersByTime(4_000);
			expect(fired).toBe(0);
			vi.advanceTimersByTime(1_000);
			expect(fired).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
