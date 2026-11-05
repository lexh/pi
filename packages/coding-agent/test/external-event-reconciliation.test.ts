import { afterEach, describe, expect, it, vi } from "vitest";
import { ExternalEventReconciler } from "../src/core/external-event-reconciliation.ts";

const pending = {
	recipientIdentity: "recipient",
	eventId: "event",
	state: "pending" as const,
	expiresAt: 1000,
	reason: null,
};

afterEach(() => vi.useRealTimers());

describe("external event reconciler", () => {
	it("invalidates expired cached proof and rejects stale reconnect responses", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const changed = vi.fn();
		const controller = new ExternalEventReconciler("session", changed);
		try {
			expect(controller.apply({ sessionId: "session", revision: 1, verified: true, events: [pending] })).toBe(true);
			await vi.advanceTimersByTimeAsync(1000);
			expect(changed).toHaveBeenCalledTimes(2);
			expect(controller.apply({ sessionId: "session", revision: 3, verified: false })).toBe(true);
			expect(controller.apply({ sessionId: "session", revision: 2, verified: true, events: [pending] })).toBe(false);
			expect(controller.getState().verified).toBe(false);
		} finally {
			controller.dispose();
		}
	});

	it("validates before replacing state and freezes copied dispositions", () => {
		const changed = vi.fn();
		const controller = new ExternalEventReconciler("session", changed);
		try {
			const event: {
				recipientIdentity: string;
				eventId: string;
				state: "pending";
				expiresAt: number;
				reason: string | null;
			} = { ...pending };
			const update = { sessionId: "session", revision: 1, verified: true as const, events: [event] };
			expect(controller.apply(update)).toBe(true);
			expect(controller.apply(update)).toBe(false);
			event.reason = "modified";
			const cached = controller.getState().dispositions.get('["recipient","event"]')!;
			expect(cached.reason).toBeNull();
			expect(Object.isFrozen(cached)).toBe(true);
			expect(() => controller.apply(update)).toThrow(/conflict/i);
			const invalid: unknown[] = [
				{ sessionId: "other", revision: 2, verified: false },
				{ sessionId: "session", revision: -1, verified: false },
				{ sessionId: "session", revision: 2, verified: false, events: [pending] },
				{ sessionId: "session", revision: 2, verified: true, events: [pending, pending] },
				{ sessionId: "session", revision: 2, verified: true, events: [{ ...pending, state: "bad" }] },
				{ sessionId: "session", revision: 2, verified: true, events: [{ ...pending, expiresAt: -1 }] },
				{ sessionId: "session", revision: 2, verified: true, events: [{ ...pending, reason: 4 }] },
				{ sessionId: "session", revision: 2, verified: true, events: [{ ...pending, eventId: "" }] },
			];
			for (const update of invalid)
				expect(() => controller.apply(update as Parameters<typeof controller.apply>[0])).toThrow();
			expect(controller.getState().revision).toBe(1);
			expect(controller.getState().dispositions.get('["recipient","event"]')).toEqual(pending);
			expect(changed).toHaveBeenCalledTimes(1);
		} finally {
			controller.dispose();
		}
	});

	it("clamps long delays without announcing expiry early", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const changed = vi.fn();
		const controller = new ExternalEventReconciler("session", changed);
		try {
			controller.apply({
				sessionId: "session",
				revision: 1,
				verified: true,
				events: [{ ...pending, expiresAt: 2_147_483_700 }],
			});
			await vi.advanceTimersByTimeAsync(2_147_483_647);
			expect(changed).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(53);
			expect(changed).toHaveBeenCalledTimes(2);
		} finally {
			controller.dispose();
		}
	});

	it("does not rearm when a deadline listener disposes the controller", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		let controller: ExternalEventReconciler;
		let calls = 0;
		controller = new ExternalEventReconciler("session", () => {
			calls++;
			if (calls === 2) controller.dispose();
		});
		controller.apply({
			sessionId: "session",
			revision: 1,
			verified: true,
			events: [pending, { ...pending, eventId: "later", expiresAt: 2000 }],
		});
		await vi.advanceTimersByTimeAsync(3000);
		expect(calls).toBe(2);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("rearms future deadlines and cancels them on disposal", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const changed = vi.fn();
		const controller = new ExternalEventReconciler("session", changed);
		controller.apply({
			sessionId: "session",
			revision: 1,
			verified: true,
			events: [pending, { ...pending, eventId: "later", expiresAt: 2000 }],
		});
		await vi.advanceTimersByTimeAsync(1000);
		expect(changed).toHaveBeenCalledTimes(2);
		controller.dispose();
		await vi.advanceTimersByTimeAsync(2000);
		expect(changed).toHaveBeenCalledTimes(2);
		expect(() => controller.apply({ sessionId: "session", revision: 2, verified: false })).toThrow(/disposed/i);
		expect(() => controller.invalidate()).toThrow(/disposed/i);
	});
});
