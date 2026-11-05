import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../src/index.ts";
import * as publicApi from "../src/index.ts";
import {
	assertExtensionRuntimeLifecycleSupport,
	assertRuntimeLifecycleSupport,
	RUNTIME_LIFECYCLE_CAPABILITIES,
} from "../src/index.ts";
import { createHarness } from "./suite/harness.ts";

describe("runtime lifecycle capability", () => {
	it("advertises the exact frozen descriptor on real SDK and extension surfaces", async () => {
		let api: ExtensionAPI | undefined;
		const h = await createHarness({
			extensionFactories: [
				(pi) => {
					api = pi;
					assertExtensionRuntimeLifecycleSupport(pi);
				},
			],
		});
		try {
			expect(RUNTIME_LIFECYCLE_CAPABILITIES).toEqual({
				protocol: "host-runtime-lifecycle/1",
				processOwnedCredential: true,
				monotonicIncarnations: true,
				synchronousEpochRevocation: true,
				authenticatedHostImages: true,
				samePidReplacement: true,
			});
			expect(Object.isFrozen(RUNTIME_LIFECYCLE_CAPABILITIES)).toBe(true);
			expect(h.session.runtimeLifecycleCapabilities).toBe(RUNTIME_LIFECYCLE_CAPABILITIES);
			expect(api?.runtimeLifecycleCapabilities).toBe(RUNTIME_LIFECYCLE_CAPABILITIES);
			expect(() => assertRuntimeLifecycleSupport(h.session)).not.toThrow();
			expect(() => assertExtensionRuntimeLifecycleSupport(api)).not.toThrow();
			expect(h.session.runtimeLifecycle.inspect().state).toBe("unregistered");
			expect(h.faux.state.callCount).toBe(0);
		} finally {
			h.cleanup();
		}
	});
	it("does not export host authority internals", () => {
		expect(publicApi).not.toHaveProperty("RuntimeHost");
		expect(publicApi).not.toHaveProperty("getProcessRuntimeHost");
		expect(publicApi).not.toHaveProperty("validateProcessHostCell");
		expect(publicApi).not.toHaveProperty("acceptReceipt");
		expect(publicApi.RuntimeReplacementInProgressError).toBeTypeOf("function");
		expect(publicApi.RuntimeDisposedError).toBeTypeOf("function");
	});
	it("checks every descriptor field and each surface's methods", () => {
		const facade = {
			participate() {},
			cancel() {},
			disconnect() {},
			inspect() {},
			capture() {},
			isCurrent() {},
			track() {},
			reconcile() {},
		};
		const session = { runtimeLifecycleCapabilities: RUNTIME_LIFECYCLE_CAPABILITIES, runtimeLifecycle: facade };
		const extension = {
			runtimeLifecycleCapabilities: RUNTIME_LIFECYCLE_CAPABILITIES,
			getRuntimeLifecycle() {
				throw new Error("must not call");
			},
		};
		expect(() => assertRuntimeLifecycleSupport(session)).not.toThrow();
		expect(() => assertExtensionRuntimeLifecycleSupport(extension)).not.toThrow();
		for (const value of [
			null,
			{},
			{ runtimeLifecycleCapabilities: {} },
			{ ...session, runtimeLifecycleCapabilities: { ...RUNTIME_LIFECYCLE_CAPABILITIES, protocol: "wrong" } },
		]) {
			expect(() => assertRuntimeLifecycleSupport(value)).toThrow(/host-runtime-lifecycle\/1/);
			expect(() => assertExtensionRuntimeLifecycleSupport(value)).toThrow(/host-runtime-lifecycle\/1/);
		}
		for (const key of Object.keys(RUNTIME_LIFECYCLE_CAPABILITIES)) {
			const descriptor = { ...RUNTIME_LIFECYCLE_CAPABILITIES, [key]: false };
			expect(() => assertRuntimeLifecycleSupport({ ...session, runtimeLifecycleCapabilities: descriptor })).toThrow(
				/host-runtime-lifecycle\/1/,
			);
			expect(() =>
				assertExtensionRuntimeLifecycleSupport({ ...extension, runtimeLifecycleCapabilities: descriptor }),
			).toThrow(/host-runtime-lifecycle\/1/);
		}
		for (const key of Object.keys(facade))
			expect(() =>
				assertRuntimeLifecycleSupport({ ...session, runtimeLifecycle: { ...facade, [key]: null } }),
			).toThrow(/host-runtime-lifecycle\/1/);
		expect(() => assertRuntimeLifecycleSupport({ ...session, runtimeLifecycle: null })).toThrow(
			/host-runtime-lifecycle\/1/,
		);
		expect(() => assertExtensionRuntimeLifecycleSupport({ ...extension, getRuntimeLifecycle: null })).toThrow(
			/host-runtime-lifecycle\/1/,
		);
	});
});
