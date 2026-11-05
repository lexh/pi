import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { CoordinationSchedulerOwner } from "../src/core/coordination-scheduler.ts";
import {
	assertCoordinationSchedulerSupport,
	assertExtensionCoordinationSchedulerSupport,
	COORDINATION_SCHEDULER_CAPABILITIES,
	EXTERNAL_EVENT_CAPABILITIES,
	type ExtensionAPI,
	type ExtensionContext,
	REQUEST_ADMISSION_CAPABILITIES,
	RUNTIME_LIFECYCLE_CAPABILITIES,
} from "../src/index.ts";
import { createCoordinationHarness, expectOneAdmission } from "./helpers/coordination.ts";
import { createHarness } from "./suite/harness.ts";

describe("coordination scheduler capability", () => {
	it("advertises the exact frozen descriptor on real session and extension surfaces without attaching", async () => {
		let api: ExtensionAPI | undefined;
		let startCtx: ExtensionContext | undefined;
		let loadTimeSupportPassed = false;
		let loadTimeGetterError: unknown;

		const h = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
					assertExtensionCoordinationSchedulerSupport(pi);
					loadTimeSupportPassed = true;
					try {
						void pi.coordinationScheduler;
					} catch (err) {
						loadTimeGetterError = err;
					}
					pi.on("session_start", (_event, ctx) => {
						startCtx = ctx;
					});
				},
			],
		});
		try {
			expect(loadTimeSupportPassed).toBe(true);
			expect(loadTimeGetterError).toBeInstanceOf(Error);
			expect((loadTimeGetterError as Error).message).toMatch(/not initialized/i);

			expect(COORDINATION_SCHEDULER_CAPABILITIES).toEqual({
				protocol: "coordination-scheduler/1",
				correlatedWaitReferences: true,
				instanceEpochPermissions: true,
				atomicAdmissionConsumption: true,
				naturalUserWakeArbitration: true,
				finalTextSettlement: true,
				idleClaims: true,
				synchronousGates: true,
				preFocusEscape: true,
				noAutomaticReplay: true,
			});
			expect(Object.isFrozen(COORDINATION_SCHEDULER_CAPABILITIES)).toBe(true);
			expect(h.session.coordinationSchedulerCapabilities).toBe(COORDINATION_SCHEDULER_CAPABILITIES);
			expect(api?.coordinationSchedulerCapabilities).toBe(COORDINATION_SCHEDULER_CAPABILITIES);
			expect(() => assertCoordinationSchedulerSupport(h.session)).not.toThrow();
			expect(() => assertExtensionCoordinationSchedulerSupport(api)).not.toThrow();
			await h.session.bindExtensions({});
			expect(api?.coordinationScheduler).toBe(h.session.coordinationScheduler);
			expect(startCtx?.coordinationScheduler).toBe(h.session.coordinationScheduler);
			expect(h.session.runtimeLifecycle.inspect().state).toBe("unregistered");
			expect(h.faux.state.callCount).toBe(0);

			// Stale runner after reload rejects both api.coordinationScheduler and startCtx.coordinationScheduler
			const oldScheduler = h.session.coordinationScheduler;
			await h.session.reload();
			expect(() => api?.coordinationScheduler).toThrow(/stale/i);
			expect(() => startCtx?.coordinationScheduler).toThrow(/stale/i);
			await expect(oldScheduler.grant({ kind: "job", attemptId: "stale" })).rejects.toThrow();
		} finally {
			h.cleanup();
		}
	});

	it("checks each field, facade method, and extension getter without invoking it", () => {
		const facade = {
			bind() {},
			wait() {},
			grant() {},
			refresh() {},
			reconcile() {},
			cancel() {},
			inspect() {},
		};
		const session = {
			coordinationSchedulerCapabilities: COORDINATION_SCHEDULER_CAPABILITIES,
			coordinationScheduler: facade,
		};
		const extension = {
			coordinationSchedulerCapabilities: COORDINATION_SCHEDULER_CAPABILITIES,
			get coordinationScheduler() {
				throw new Error("not bound");
			},
		};
		expect(() => assertCoordinationSchedulerSupport(session)).not.toThrow();
		expect(() => assertExtensionCoordinationSchedulerSupport(extension)).not.toThrow();

		for (const key of Object.keys(COORDINATION_SCHEDULER_CAPABILITIES)) {
			const descriptor = { ...COORDINATION_SCHEDULER_CAPABILITIES, [key]: false };
			expect(() =>
				assertCoordinationSchedulerSupport({ ...session, coordinationSchedulerCapabilities: descriptor }),
			).toThrow(/coordination-scheduler\/1/);
			const badExtension = Object.defineProperty(
				{ coordinationSchedulerCapabilities: descriptor },
				"coordinationScheduler",
				{
					get() {
						throw new Error("not bound");
					},
				},
			);
			expect(() => assertExtensionCoordinationSchedulerSupport(badExtension)).toThrow(/coordination-scheduler\/1/);
		}
		for (const key of Object.keys(facade)) {
			expect(() =>
				assertCoordinationSchedulerSupport({ ...session, coordinationScheduler: { ...facade, [key]: null } }),
			).toThrow(/coordination-scheduler\/1/);
		}
		for (const value of [
			null,
			{},
			{ coordinationSchedulerCapabilities: {} },
			{ ...session, coordinationScheduler: null },
		]) {
			expect(() => assertCoordinationSchedulerSupport(value)).toThrow(/coordination-scheduler\/1/);
		}
		expect(() =>
			assertExtensionCoordinationSchedulerSupport({
				coordinationSchedulerCapabilities: COORDINATION_SCHEDULER_CAPABILITIES,
			}),
		).toThrow(/coordination-scheduler\/1/);
		expect(() => assertExtensionCoordinationSchedulerSupport(session)).toThrow(/coordination-scheduler\/1/);
	});

	it("requires all five independent capabilities and a saved session before binding without poisoning a later bind", async () => {
		const fixture = await createCoordinationHarness();
		try {
			const { harness, coordinator, manager } = fixture;

			// 1. Missing durable-records/1 descriptor on the saved SessionManager
			const origRecordCapabilities = manager.recordCapabilities;
			Object.defineProperty(manager, "recordCapabilities", { value: {}, configurable: true });
			expect(() => harness.session.coordinationScheduler.bind(coordinator)).toThrow(/durable-records\/1/);
			expect((fixture.scheduler as CoordinationSchedulerOwner).isBound).toBe(false);
			expect(harness.session.isRequestAdmissionBound).toBe(false);
			Object.defineProperty(manager, "recordCapabilities", {
				value: origRecordCapabilities,
				configurable: true,
			});
			expect(harness.session.coordinationScheduler.inspect().bound).toBe(false);
			expect(harness.session.runtimeLifecycle.isCurrent(fixture.fence)).toBe(true);

			// 2. Missing externalEventCapabilities
			Object.defineProperty(harness.session, "externalEventCapabilities", { value: {}, configurable: true });
			expect(() => harness.session.coordinationScheduler.bind(coordinator)).toThrow(/logical-external-events\/1/);
			expect(harness.session.coordinationScheduler.inspect().bound).toBe(false);
			expect(harness.session.isRequestAdmissionBound).toBe(false);
			Object.defineProperty(harness.session, "externalEventCapabilities", {
				value: EXTERNAL_EVENT_CAPABILITIES,
				configurable: true,
			});

			// 3. Missing runtimeLifecycleCapabilities
			Object.defineProperty(harness.session, "runtimeLifecycleCapabilities", { value: {}, configurable: true });
			expect(() => harness.session.coordinationScheduler.bind(coordinator)).toThrow(/host-runtime-lifecycle\/1/);
			expect(harness.session.coordinationScheduler.inspect().bound).toBe(false);
			expect(harness.session.isRequestAdmissionBound).toBe(false);
			Object.defineProperty(harness.session, "runtimeLifecycleCapabilities", {
				value: RUNTIME_LIFECYCLE_CAPABILITIES,
				configurable: true,
			});

			// 4. Missing requestAdmissionCapabilities
			Object.defineProperty(harness.session, "requestAdmissionCapabilities", { value: {}, configurable: true });
			expect(() => harness.session.coordinationScheduler.bind(coordinator)).toThrow(/ordered-request-admission\/1/);
			expect(harness.session.coordinationScheduler.inspect().bound).toBe(false);
			expect(harness.session.isRequestAdmissionBound).toBe(false);
			Object.defineProperty(harness.session, "requestAdmissionCapabilities", {
				value: REQUEST_ADMISSION_CAPABILITIES,
				configurable: true,
			});

			// 5. Missing coordinationSchedulerCapabilities
			Object.defineProperty(harness.session, "coordinationSchedulerCapabilities", {
				value: {},
				configurable: true,
			});
			expect(() => harness.session.coordinationScheduler.bind(coordinator)).toThrow(/coordination-scheduler\/1/);
			expect(harness.session.coordinationScheduler.inspect().bound).toBe(false);
			expect(harness.session.isRequestAdmissionBound).toBe(false);
			Object.defineProperty(harness.session, "coordinationSchedulerCapabilities", {
				value: COORDINATION_SCHEDULER_CAPABILITIES,
				configurable: true,
			});

			// 6. Ephemeral (--no-session) session rejected by assertRecordSupport without poisoning
			const ephemeral = await createHarness();
			try {
				expect(() => assertCoordinationSchedulerSupport(ephemeral.session)).not.toThrow();
				expect(() => ephemeral.session.coordinationScheduler.bind(coordinator)).toThrow(/--no-session/);
				expect(ephemeral.session.coordinationScheduler.inspect().bound).toBe(false);
				expect(ephemeral.session.isRequestAdmissionBound).toBe(false);
			} finally {
				ephemeral.cleanup();
			}

			// 7. Bind after all five capabilities pass succeeds and owns ordered admission
			const unbind = harness.session.coordinationScheduler.bind(coordinator);
			expect(harness.session.coordinationScheduler.inspect().bound).toBe(true);
			expect(harness.session.isRequestAdmissionBound).toBe(true);

			const event = coordinator.seedEvent("cap-wake-event", "CAP_WAKE_BODY");
			coordinator.coordination.record({
				reference: event,
				recordedAt: Date.now(),
				match: { kind: "job", attemptId: "job-cap-wake" },
			});
			harness.setResponses([fauxAssistantMessage("wake after capability bind")]);
			const receipt = await harness.session.coordinationScheduler.grant({
				kind: "job",
				attemptId: "job-cap-wake",
			});
			await vi.waitFor(() => {
				expect(harness.faux.state.callCount).toBe(1);
			});
			await harness.session.waitForIdle();
			expectOneAdmission(manager, event);
			expect(harness.session.coordinationScheduler.inspect().grants).toEqual([
				{ grantId: receipt.grantId, state: "consumed" },
			]);

			unbind();
			expect(harness.session.isRequestAdmissionBound).toBe(false);
			harness.setResponses([fauxAssistantMessage("ordinary after unbind")]);
			await harness.session.prompt("ordinary");
			expect(harness.faux.state.callCount).toBe(2);
		} finally {
			fixture.cleanup();
		}
	});
});
