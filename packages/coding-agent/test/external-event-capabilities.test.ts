import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../src/index.ts";
import {
	assertExtensionExternalEventSupport,
	assertExternalEventProjectionSupport,
	assertRecordSupport,
	EXTERNAL_EVENT_CAPABILITIES,
	RECORD_CAPABILITIES,
	SessionManager,
} from "../src/index.ts";
import { savedFixture } from "./helpers/external-events.ts";
import { createHarness } from "./suite/harness.ts";

const error =
	"External event integration disabled: install a pi build with durable-records/1 and logical-external-events/1. Ordinary pi remains available.";

describe("external event capability gates", () => {
	it("advertises identical frozen capabilities on real session and extension surfaces", async () => {
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
				},
			],
		});
		try {
			expect(harness.faux.state.callCount).toBe(0);
			expect(Object.isFrozen(EXTERNAL_EVENT_CAPABILITIES)).toBe(true);
			expect(harness.session.externalEventCapabilities).toBe(EXTERNAL_EVENT_CAPABILITIES);
			expect(api?.externalEventCapabilities).toBe(EXTERNAL_EVENT_CAPABILITIES);
			expect(() => assertExternalEventProjectionSupport(harness.session)).not.toThrow();
			expect(() => assertExtensionExternalEventSupport(api)).not.toThrow();
			expect(() => assertRecordSupport(harness.sessionManager)).toThrow("--no-session");
		} finally {
			harness.cleanup();
		}
	});

	it("checks every descriptor field and the methods for each distinct surface", () => {
		const session = {
			externalEventCapabilities: EXTERNAL_EVENT_CAPABILITIES,
			refreshExternalEvents() {},
			getExternalEventView() {},
		};
		const extension = { externalEventCapabilities: EXTERNAL_EVENT_CAPABILITIES, refreshExternalEvents() {} };
		expect(() => assertExternalEventProjectionSupport(session)).not.toThrow();
		expect(() => assertExtensionExternalEventSupport(extension)).not.toThrow();
		for (const value of [
			{},
			{ recordCapabilities: RECORD_CAPABILITIES },
			{ externalEventCapabilities: EXTERNAL_EVENT_CAPABILITIES },
			{ ...session, refreshExternalEvents: null },
			{
				...session,
				externalEventCapabilities: { ...EXTERNAL_EVENT_CAPABILITIES, contract: "logical-external-events/2" },
			},
		]) {
			expect(() => assertExternalEventProjectionSupport(value)).toThrow(error);
			expect(() => assertExtensionExternalEventSupport(value)).toThrow(error);
		}
		expect(() => assertExternalEventProjectionSupport(extension)).toThrow(error);
		for (const key of Object.keys(EXTERNAL_EVENT_CAPABILITIES)) {
			const descriptor = { ...EXTERNAL_EVENT_CAPABILITIES, [key]: false };
			expect(() =>
				assertExternalEventProjectionSupport({ ...session, externalEventCapabilities: descriptor }),
			).toThrow(error);
			expect(() =>
				assertExtensionExternalEventSupport({ ...extension, externalEventCapabilities: descriptor }),
			).toThrow(error);
		}
		const ephemeral = SessionManager.inMemory();
		expect(() => assertRecordSupport(ephemeral)).toThrow("--no-session");
		const saved = savedFixture();
		try {
			expect(() => assertRecordSupport(saved.manager)).not.toThrow();
			expect(() => assertExternalEventProjectionSupport(saved.manager)).toThrow(error);
		} finally {
			saved.cleanup();
		}
	});
});
