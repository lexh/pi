import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	assertExtensionRequestAdmissionSupport,
	assertRequestAdmissionSupport,
	EXTERNAL_EVENT_CAPABILITIES,
	type ExtensionAPI,
	REQUEST_ADMISSION_CAPABILITIES,
	RUNTIME_LIFECYCLE_CAPABILITIES,
} from "../src/index.ts";
import { createAdmissionHarness } from "./helpers/request-admission.ts";
import { createHarness } from "./suite/harness.ts";

describe("ordered request admission capability", () => {
	it("advertises the exact frozen descriptor on real session and extension surfaces without attaching", async () => {
		let api: ExtensionAPI | undefined;
		const h = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});
		try {
			expect(REQUEST_ADMISSION_CAPABILITIES).toEqual({
				protocol: "ordered-request-admission/1",
				finiteSnapshot: true,
				finalContextInclusion: true,
				canonicalReceiptBarrier: true,
				unreadSafeCompaction: true,
				atomicAdmissionConsumptionJoin: true,
				durableAnchoredMaterialization: true,
				cancellationFencing: true,
				recoveryWithoutReplay: true,
			});
			expect(Object.isFrozen(REQUEST_ADMISSION_CAPABILITIES)).toBe(true);
			expect(h.session.requestAdmissionCapabilities).toBe(REQUEST_ADMISSION_CAPABILITIES);
			expect(api?.requestAdmissionCapabilities).toBe(REQUEST_ADMISSION_CAPABILITIES);
			expect(() => assertRequestAdmissionSupport(h.session)).not.toThrow();
			expect(() => assertExtensionRequestAdmissionSupport(api)).not.toThrow();
			expect(api?.requestAdmission).toBe(h.session.requestAdmission);
			expect(h.session.runtimeLifecycle.inspect().state).toBe("unregistered");
			expect(h.faux.state.callCount).toBe(0);
		} finally {
			h.cleanup();
		}
	});

	it("checks each field, facade method and extension getter without invoking it", () => {
		const facade = { bind() {}, stageCompletedWait() {}, reconcile() {} };
		const session = { requestAdmissionCapabilities: REQUEST_ADMISSION_CAPABILITIES, requestAdmission: facade };
		const extension = {
			requestAdmissionCapabilities: REQUEST_ADMISSION_CAPABILITIES,
			get requestAdmission() {
				throw new Error("not bound");
			},
		};
		expect(() => assertRequestAdmissionSupport(session)).not.toThrow();
		expect(() => assertExtensionRequestAdmissionSupport(extension)).not.toThrow();
		for (const key of Object.keys(REQUEST_ADMISSION_CAPABILITIES)) {
			const descriptor = { ...REQUEST_ADMISSION_CAPABILITIES, [key]: false };
			expect(() => assertRequestAdmissionSupport({ ...session, requestAdmissionCapabilities: descriptor })).toThrow(
				/ordered-request-admission\/1/,
			);
			const badExtension = Object.defineProperty({ requestAdmissionCapabilities: descriptor }, "requestAdmission", {
				get() {
					throw new Error("not bound");
				},
			});
			expect(() => assertExtensionRequestAdmissionSupport(badExtension)).toThrow(/ordered-request-admission\/1/);
		}
		for (const key of Object.keys(facade))
			expect(() =>
				assertRequestAdmissionSupport({ ...session, requestAdmission: { ...facade, [key]: null } }),
			).toThrow(/ordered-request-admission\/1/);
		for (const value of [null, {}, { requestAdmissionCapabilities: {} }, { ...session, requestAdmission: null }])
			expect(() => assertRequestAdmissionSupport(value)).toThrow(/ordered-request-admission\/1/);
		expect(() =>
			assertExtensionRequestAdmissionSupport({ requestAdmissionCapabilities: REQUEST_ADMISSION_CAPABILITIES }),
		).toThrow(/ordered-request-admission\/1/);
		expect(() => assertExtensionRequestAdmissionSupport(session)).toThrow(/ordered-request-admission\/1/);
	});

	it("requires independent support before binding without poisoning a later bind", async () => {
		const fixture = await createAdmissionHarness();
		try {
			const { harness, coordinator } = fixture;
			Object.defineProperty(harness.session, "externalEventCapabilities", { value: {}, configurable: true });
			expect(() => harness.session.requestAdmission.bind(coordinator)).toThrow(/logical-external-events\/1/);
			expect(harness.session.isRequestAdmissionBound).toBe(false);
			delete (harness.session as { externalEventCapabilities?: unknown }).externalEventCapabilities;
			// Restore the instance field after deliberately simulating an unsupported build.
			Object.defineProperty(harness.session, "externalEventCapabilities", {
				value: EXTERNAL_EVENT_CAPABILITIES,
				configurable: true,
			});
			Object.defineProperty(harness.session, "runtimeLifecycleCapabilities", { value: {}, configurable: true });
			expect(() => harness.session.requestAdmission.bind(coordinator)).toThrow(/host-runtime-lifecycle\/1/);
			expect(harness.session.isRequestAdmissionBound).toBe(false);
			Object.defineProperty(harness.session, "runtimeLifecycleCapabilities", {
				value: RUNTIME_LIFECYCLE_CAPABILITIES,
				configurable: true,
			});
			const ephemeral = await createHarness();
			try {
				expect(() => assertRequestAdmissionSupport(ephemeral.session)).not.toThrow();
				expect(() => ephemeral.session.requestAdmission.bind(coordinator)).toThrow(/--no-session/);
				expect(ephemeral.session.isRequestAdmissionBound).toBe(false);
			} finally {
				ephemeral.cleanup();
			}
			const dispose = harness.session.requestAdmission.bind(coordinator);
			expect(harness.session.isRequestAdmissionBound).toBe(true);
			dispose();
			harness.setResponses([fauxAssistantMessage("ordinary")]);
			await harness.session.prompt("ordinary");
			expect(harness.faux.state.callCount).toBe(1);
		} finally {
			fixture.cleanup();
		}
	});
});
