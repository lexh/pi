import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import managedExample from "../examples/extensions/managed-spawn.ts";
import {
	assertExtensionManagedProcessSupport,
	MANAGED_PROCESS_CAPABILITIES,
} from "../src/core/managed-process-capabilities.ts";
import type { ExtensionAPI } from "../src/index.ts";
import * as publicApi from "../src/index.ts";
import { createHarness, getMessageText, getToolResult } from "./suite/harness.ts";
import { createTestExtensionsResult } from "./utilities.ts";

test("extension guard checks the own getter without invoking it during load", async () => {
	let checked = false;
	const result = await createTestExtensionsResult(
		[
			async (pi) => {
				assertExtensionManagedProcessSupport(pi);
				expect(Object.isFrozen(pi.managedProcessCapabilities)).toBe(true);
				expect(pi.managedProcessCapabilities).toEqual(MANAGED_PROCESS_CAPABILITIES);
				expect(() => pi.managedProcesses).toThrow(/not initialized/);
				const ordinary = await pi.exec(process.execPath, ["-e", "process.stdout.write('ordinary')"]);
				expect(ordinary.stdout).toBe("ordinary");
				checked = true;
			},
		],
		process.cwd(),
	);
	expect(result.errors).toEqual([]);
	expect(checked).toBe(true);
	const imposter = { managedProcessCapabilities: MANAGED_PROCESS_CAPABILITIES, managedProcesses: {} };
	expect(() => assertExtensionManagedProcessSupport(imposter)).toThrow(/disabled/);
});

test("the public API exposes the descriptor and both guards, and keeps registry internals private", async () => {
	let api: ExtensionAPI | undefined;
	const h = await createHarness({
		extensionFactories: [
			(pi) => {
				api = pi;
			},
		],
	});
	try {
		expect(publicApi.MANAGED_PROCESS_CAPABILITIES).toBe(MANAGED_PROCESS_CAPABILITIES);
		expect(h.session.managedProcessCapabilities).toBe(MANAGED_PROCESS_CAPABILITIES);
		expect(api?.managedProcessCapabilities).toBe(MANAGED_PROCESS_CAPABILITIES);
		expect(() => publicApi.assertManagedProcessSupport(h.session)).not.toThrow();
		expect(() => publicApi.assertExtensionManagedProcessSupport(api)).not.toThrow();
		expect(publicApi.readLocalProcessBirth).toBeTypeOf("function");
		for (const internal of [
			"ManagedProcessRegistry",
			"ManagedProcessOwner",
			"launchManaged",
			"spawnGate",
			"withManagedCall",
		])
			expect(publicApi).not.toHaveProperty(internal);
		expect(h.faux.state.callCount).toBe(0);
	} finally {
		h.cleanup();
	}
});

test("the facade exposes stop acknowledgement and finalization, and the guard requires every member", async () => {
	const h = await createHarness();
	try {
		const facade = h.session.managedProcesses;
		const members = [
			"acknowledgeStop",
			"bind",
			"captureAttemptVersion",
			"declareTaskFinalization",
			"inspect",
			"managedSpawn",
			"reconcile",
			"reconcileAttempt",
			"reconcileFinalizations",
			"requestStop",
		];
		expect(Object.keys(facade).sort()).toEqual(members);
		for (const member of members) {
			const broken = {
				managedProcessCapabilities: MANAGED_PROCESS_CAPABILITIES,
				managedProcesses: { ...facade, [member]: undefined },
			};
			expect(() => publicApi.assertManagedProcessSupport(broken)).toThrow(/disabled/);
		}
	} finally {
		h.cleanup();
	}
});

test("the managed-spawn example runs as a tool and reports the local exit", async () => {
	const h = await createHarness({ extensionFactories: [managedExample] });
	try {
		h.session.setActiveToolsByName(["managed_example"]);
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("managed_example", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("run the managed example");
		expect(getMessageText(getToolResult(h, "managed_example"))).toContain("Local exit: 0");
	} finally {
		h.cleanup();
	}
});
