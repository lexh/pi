import { describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/config.ts";
import * as firstUser from "../src/core/runtime-host.ts";
import * as secondUser from "../src/core/runtime-host.ts";
import { resolveConversationBinding } from "../src/core/runtime-incarnation.ts";
import { savedFixture } from "./helpers/external-events.ts";
import { FakeRuntimeCoordinator } from "./helpers/fake-runtime-coordinator.ts";

const unused = () => {
	throw new Error("must remain lazy");
};

describe("process runtime host", () => {
	it("shares one host across module users but never reuses an incarnation", () => {
		const host = firstUser.getProcessRuntimeHost();
		expect(secondUser.getProcessRuntimeHost()).toBe(host);
		const a = host.open(unused);
		const b = host.open(unused);
		expect(b.inspect().hostId).toBe(a.inspect().hostId);
		expect(b.inspect().incarnation).toBeGreaterThan(a.inspect().incarnation);
		expect(b.inspect().instanceId).not.toBe(a.inspect().instanceId);
		expect(JSON.stringify(a.inspect())).not.toContain("credential");
		expect(Object.isFrozen(a.inspect())).toBe(true);
		expect(Object.isFrozen(a.inspect().process)).toBe(true);
		a.retire("quit");
		b.retire("quit");
	});

	it("reuses the live cell after an actual module reload", async () => {
		const fixture = savedFixture();
		const host = firstUser.getProcessRuntimeHost();
		const scope = host.open(() => resolveConversationBinding(fixture.manager));
		try {
			scope.participate();
			await scope.reconcile(new FakeRuntimeCoordinator().exchange);
			const fence = scope.capture();
			vi.resetModules();
			const reloaded = await vi.importActual<typeof firstUser>("../src/core/runtime-host.ts");
			expect(reloaded.RuntimeHost).not.toBe(firstUser.RuntimeHost);
			expect(reloaded.getProcessRuntimeHost()).toBe(host);
			const next = reloaded.getProcessRuntimeHost().open(unused);
			expect(next.inspect().hostId).toBe(fence.hostId);
			expect(next.inspect().incarnation).toBeGreaterThan(fence.incarnation);
			expect(scope.isCurrent(fence)).toBe(true);
			next.retire("quit");
		} finally {
			scope.retire("quit");
			fixture.cleanup();
		}
	});

	it("distinguishes PID reuse and does not derive credentials from the PID", () => {
		let id = 0;
		const ids = () => `opaque-${++id}`;
		const a = new firstUser.RuntimeHost({ process: { pid: 42, birthNonce: "birth-a" }, ids });
		const b = new firstUser.RuntimeHost({ process: { pid: 42, birthNonce: "birth-b" }, ids });
		expect(a.open(unused).inspect().hostId).not.toBe(b.open(unused).inspect().hostId);
	});

	it("fails closed on invalid or exhausted counters", () => {
		for (const incarnation of [Number.MAX_SAFE_INTEGER, -1, 0.5, Number.NaN]) {
			const host = new firstUser.RuntimeHost({ initialCounters: { incarnation } });
			expect(() => host.open(unused)).toThrow(/counter exhausted/);
		}
	});

	it("refuses a standalone cell belonging to a different package version", () => {
		const host = firstUser.getProcessRuntimeHost();
		expect(() =>
			firstUser.validateProcessHostCell({ version: 1, packageVersion: "different-package-version", host }),
		).toThrow(/unavailable/);
		expect(firstUser.getProcessRuntimeHost()).toBe(host);
	});

	it("rejects incompatible and malformed cells without touching the live singleton", () => {
		for (const value of [undefined, null, {}, { version: 2 }, { version: 1, host: {} }]) {
			expect(() => firstUser.validateProcessHostCell(value)).toThrow(/unavailable/);
		}
		const host = firstUser.getProcessRuntimeHost();
		expect(firstUser.validateProcessHostCell({ version: 1, packageVersion: VERSION, host })).toBe(host);
	});
});
