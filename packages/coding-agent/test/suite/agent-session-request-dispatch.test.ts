import { AgentRequestSuppressedError } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxProvider, lazyStream } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { ExtensionFactory } from "../../src/core/extensions/types.ts";
import { RequestAdmissionOwner } from "../../src/core/request-admission.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { savedFixture } from "../helpers/external-events.ts";
import { FakeRequestCoordinator } from "../helpers/fake-request-coordinator.ts";
import { FakeRuntimeCoordinator } from "../helpers/fake-runtime-coordinator.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "../model-runtime-test-utils.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";

async function fixture(factory?: ExtensionFactory, warming: false | "idle" | "streaming" = false) {
	const saved = savedFixture();
	const faux = fauxProvider();
	const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	const runtime = getModelRuntime(registry);
	let setup = 0;
	let invoked = 0;
	const payloadErrors: unknown[] = [];
	const inputs: unknown[] = [];
	const payloads: unknown[] = [];
	const nativeOptions: Array<{ observedHeader: string | null | undefined; hasAdmissionGuard: boolean }> = [];
	const settlements: string[] = [];
	let adoptions = 0;
	runtime.registerNativeProvider({
		...faux.provider,
		streamSimple(model, context, options) {
			setup++;
			nativeOptions.push({
				observedHeader: options?.headers?.["x-observed"],
				hasAdmissionGuard: Object.hasOwn(options ?? {}, "assertRequestCurrent"),
			});
			return lazyStream(model, async () => {
				const payload = { messages: structuredClone(context.messages) };
				try {
					const replacement = await options?.onPayload?.(payload, model);
					payloads.push(structuredClone(replacement === undefined ? payload : replacement));
				} catch (error) {
					payloadErrors.push(error);
					throw error;
				}
				invoked++;
				inputs.push(structuredClone(context));
				return faux.provider.streamSimple(model, context, options);
			});
		},
	});
	const extensions = await createTestExtensionsResult(factory ? [factory] : [], saved.directory);
	const resourceLoader = createTestResourceLoader({ extensionsResult: extensions });
	const model = warming
		? {
				...faux.getModel(),
				promptCache: { short: 300 },
				cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
			}
		: faux.getModel();
	const { session } = await createAgentSession({
		cwd: saved.directory,
		agentDir: saved.directory,
		model,
		modelRuntime: runtime,
		settingsManager: SettingsManager.inMemory({ cacheWarming: warming || "off" }),
		sessionManager: saved.manager,
		resourceLoader,
		noTools: "all",
	});
	if (!(session.requestAdmission instanceof RequestAdmissionOwner)) throw new Error("Expected admission owner");
	const owner = session.requestAdmission;
	const finalize = owner.finalize.bind(owner);
	vi.spyOn(owner, "finalize").mockImplementation(async (...args) => {
		const result = await finalize(...args);
		if (!result) return result;
		return {
			...result,
			onAssistantStart: () => {
				adoptions++;
				result.onAssistantStart();
			},
			settle: async (outcome) => {
				settlements.push(outcome);
				await result.settle(outcome);
			},
		};
	});
	await session.bindExtensions({});
	const authority = new FakeRuntimeCoordinator();
	session.runtimeLifecycle.participate();
	await session.runtimeLifecycle.reconcile(authority.exchange);
	const coordinator = new FakeRequestCoordinator(
		authority,
		undefined,
		undefined,
		session.runtimeLifecycle.capture().mailboxId,
	);
	const initialAssistantCount = saved.manager
		.getBranch()
		.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length;
	const events: string[] = [];
	session.subscribe((event) => {
		if (event.type === "request_suppressed") events.push(event.reason);
	});
	faux.setResponses([fauxAssistantMessage("done")]);
	return {
		session,
		manager: saved.manager,
		coordinator,
		authority,
		initialAssistantCount,
		faux,
		runtime,
		events,
		payloadErrors,
		payloads,
		nativeOptions,
		settlements,
		adoptions: () => adoptions,
		inputs,
		setup: () => setup,
		invoked: () => invoked,
		cleanup: () => {
			session.dispose();
			saved.cleanup();
		},
	};
}

function expectSuppressedAtRoot(f: Awaited<ReturnType<typeof fixture>>) {
	const stored = f.coordinator.exportRecoveryImage().requests[0];
	expect(stored.result.requestId).toBe(stored.proposal.request.requestId);
	expect(f.manager.getLeafId()).toBe(stored.proposal.request.branchAnchor);
	expect(
		f.manager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "assistant"),
	).toHaveLength(f.initialAssistantCount);
	expect(f.session.messages).toEqual(f.manager.buildSessionProjection().messages);
	expect(f.adoptions()).toBe(0);
	expect(f.settlements).toEqual(["dispatch-uncertain"]);
}

describe("real SDK coordinated dispatch", () => {
	const fixtures: Array<Awaited<ReturnType<typeof fixture>>> = [];
	afterEach(() => {
		for (const item of fixtures.splice(0)) item.cleanup();
		vi.useRealTimers();
	});

	it.each(["replace", "mutate", "null"] as const)("suppresses %s payload through the real SDK", async (mode) => {
		const f = await fixture((pi) => {
			pi.on("before_provider_request", (event) => {
				if (mode === "replace") return { changed: true };
				if (mode === "null") return null;
				if (event.payload && typeof event.payload === "object") Object.assign(event.payload, { changed: true });
			});
		});
		fixtures.push(f);
		const priorAssistants = f.manager
			.getBranch()
			.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length;
		const event = f.coordinator.seedEvent("payload", "PAYLOAD_PRIVATE");
		f.session.requestAdmission.bind(f.coordinator);
		await f.session.prompt("request");
		expect(f.setup()).toBe(1);
		expect(f.invoked()).toBe(0);
		expect(f.faux.state.callCount).toBe(0);
		expect(f.coordinator.inspectEvent(event)?.state).toBe("read");
		expect(f.payloadErrors).toHaveLength(1);
		expect(f.payloadErrors[0]).toBeInstanceOf(AgentRequestSuppressedError);
		expect(f.payloadErrors[0]).toMatchObject({ reason: "payload-mutated" });
		expect(f.settlements).toEqual(["dispatch-uncertain"]);
		expect(f.adoptions()).toBe(0);
		expectSuppressedAtRoot(f);
		expect(
			f.manager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "assistant"),
		).toHaveLength(priorAssistants);
		expect(f.events).toHaveLength(1);
		expect(
			f.manager
				.getBranch()
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.content.some((part) => part.type === "text" && part.text === "done"),
				),
		).toHaveLength(0);
	});

	it("allows observational payload and headers on a bound request", async () => {
		const observed: unknown[] = [];
		const f = await fixture((pi) => {
			pi.on("before_provider_request", (event) => {
				observed.push(structuredClone(event.payload));
			});
			pi.on("before_provider_headers", (event) => {
				event.headers["x-observed"] = "yes";
			});
		});
		fixtures.push(f);
		const event = f.coordinator.seedEvent("observed", "OBSERVED_BODY");
		f.session.requestAdmission.bind(f.coordinator);
		await f.session.prompt("request");
		expect(f.setup()).toBe(1);
		expect(f.invoked()).toBe(1);
		expect(f.faux.state.callCount).toBe(1);
		expect(f.coordinator.inspectEvent(event)?.state).toBe("read");
		expect(JSON.stringify(observed)).toContain("OBSERVED_BODY");
		expect(JSON.stringify(f.inputs)).toContain("OBSERVED_BODY");
		expect(JSON.stringify(f.payloads)).toContain("OBSERVED_BODY");
		expect(f.adoptions()).toBe(1);
		const stored = f.coordinator.exportRecoveryImage().requests[0];
		expect(stored.result.requestId).toBe(stored.proposal.request.requestId);
		expect(f.manager.getEntry(f.manager.getLeafId()!)?.parentId).toBe(stored.result.entries[0].entryId);
		expect(f.nativeOptions).toHaveLength(1);
		expect(f.nativeOptions[0].observedHeader).toBe("yes");
		expect(f.nativeOptions[0].hasAdmissionGuard).toBe(false);
		const payload = f.payloads[0] as { messages: Array<{ role: string; content: unknown }> };
		const admitted = payload.messages.filter(
			(message) => message.role === "user" && JSON.stringify(message.content).includes("OBSERVED_BODY"),
		);
		expect(admitted).toHaveLength(1);
		expect(admitted[0].content).toEqual([{ type: "text", text: stored.result.entries[0].record.envelope }]);
		expect(f.settlements).toEqual(["dispatch-uncertain"]);
		expect(f.events).toEqual([]);
	});

	it("does not upgrade an old request across actual disconnect and reconcile", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const f = await fixture();
		fixtures.push(f);
		const event = f.coordinator.seedEvent("reconnect", "RECONNECT_PRIVATE");
		f.session.requestAdmission.bind(f.coordinator);
		const oldFence = f.session.runtimeLifecycle.capture();
		const original = f.runtime.getAuth.bind(f.runtime);
		let first = true;
		vi.spyOn(f.runtime, "getAuth").mockImplementation(async (...args) => {
			if (first) {
				first = false;
				entered.resolve();
				await release.promise;
			}
			return original(...args);
		});
		const admit = vi.spyOn(f.coordinator, "admit");
		let starts = 0;
		f.session.subscribe((value) => {
			if (value.type === "agent_start") starts++;
		});
		const running = f.session.prompt("old request");
		await entered.promise;
		f.authority.disconnect();
		f.session.runtimeLifecycle.disconnect();
		expect(f.session.runtimeLifecycle.isCurrent(oldFence)).toBe(false);
		f.authority.reconnect();
		await f.session.runtimeLifecycle.reconcile(f.authority.exchange);
		const fresh = f.session.runtimeLifecycle.capture();
		expect(fresh.verificationRevision).not.toBe(oldFence.verificationRevision);
		expect(starts).toBe(1);
		expect(f.setup()).toBe(0);
		expect(f.faux.state.callCount).toBe(0);
		release.resolve();
		await running;
		expect(f.setup()).toBe(0);
		expect(f.invoked()).toBe(0);
		expect(f.faux.state.callCount).toBe(0);
		expect(f.coordinator.inspectEvent(event)?.state).toBe("read");
		expectSuppressedAtRoot(f);
		await f.session.prompt("new explicit request");
		expect(starts).toBe(2);
		expect(f.setup()).toBe(1);
		expect(f.invoked()).toBe(1);
		expect(f.faux.state.callCount).toBe(1);
		expect(admit).toHaveBeenCalledTimes(1);
	});

	it.each(["auth", "headers", "payload"] as const)("revokes an actual local abort during %s", async (gate) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const f = await fixture((pi) => {
			pi.on("before_provider_headers", async () => {
				if (gate === "headers") {
					entered.resolve();
					await release.promise;
				}
			});
			pi.on("before_provider_request", async () => {
				if (gate === "payload") {
					entered.resolve();
					await release.promise;
				}
			});
		});
		fixtures.push(f);
		const event = f.coordinator.seedEvent(`abort-${gate}`, `ABORT_${gate}`);
		const suppressed = vi.spyOn(f.coordinator, "suppressed");
		f.session.requestAdmission.bind(f.coordinator);
		const fence = f.session.runtimeLifecycle.capture();
		if (gate === "auth") {
			const original = f.runtime.getAuth.bind(f.runtime);
			vi.spyOn(f.runtime, "getAuth").mockImplementation(async (...args) => {
				entered.resolve();
				await release.promise;
				return original(...args);
			});
		}
		const running = f.session.prompt("request");
		await entered.promise;
		const aborting = f.session.abort();
		const current = f.session.runtimeLifecycle.isCurrent(fence);
		release.resolve();
		await Promise.all([running, aborting]);
		expect(current).toBe(false);
		expect(f.setup()).toBe(gate === "payload" ? 1 : 0);
		expect(f.invoked()).toBe(0);
		expect(f.faux.state.callCount).toBe(0);
		expect(f.coordinator.inspectEvent(event)?.state).toBe("read");
		expect(suppressed).not.toHaveBeenCalled();
		expectSuppressedAtRoot(f);
	});

	it("does not invoke the provider after the auth gate is invalidated", async () => {
		const f = await fixture();
		fixtures.push(f);
		const event = f.coordinator.seedEvent("auth", "AUTH_BODY");
		const dispose = f.session.requestAdmission.bind(f.coordinator);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const original = f.runtime.getAuth.bind(f.runtime);
		vi.spyOn(f.runtime, "getAuth").mockImplementation(async (...args) => {
			entered.resolve();
			await release.promise;
			return original(...args);
		});
		const running = f.session.prompt("request");
		await entered.promise;
		dispose();
		release.resolve();
		await running;
		expect(f.setup()).toBe(0);
		expect(f.invoked()).toBe(0);
		expect(f.faux.state.callCount).toBe(0);
		expect(f.coordinator.inspectEvent(event)?.state).toBe("read");
		expect(f.events).toHaveLength(1);
		expectSuppressedAtRoot(f);
	});

	it("suppresses an auth rejection after binding invalidation", async () => {
		const f = await fixture();
		fixtures.push(f);
		const event = f.coordinator.seedEvent("auth-rejection", "AUTH_REJECT_BODY");
		const dispose = f.session.requestAdmission.bind(f.coordinator);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		vi.spyOn(f.runtime, "getAuth").mockImplementation(async () => {
			entered.resolve();
			await release.promise;
			throw new Error("auth failed");
		});
		const running = f.session.prompt("request");
		await entered.promise;
		dispose();
		release.resolve();
		await running;
		expect(f.setup()).toBe(0);
		expect(f.invoked()).toBe(0);
		expect(f.faux.state.callCount).toBe(0);
		expect(f.coordinator.inspectEvent(event)?.state).toBe("read");
		expect(f.events).toHaveLength(1);
		expect(
			f.session.messages.some((message) => message.role === "assistant" && message.errorMessage === "auth failed"),
		).toBe(false);
		expectSuppressedAtRoot(f);
	});

	it("does not invoke the provider after the header gate is invalidated", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const f = await fixture((pi) => {
			pi.on("before_provider_headers", async () => {
				entered.resolve();
				await release.promise;
			});
		});
		fixtures.push(f);
		const event = f.coordinator.seedEvent("header", "HEADER_BODY");
		const dispose = f.session.requestAdmission.bind(f.coordinator);
		const running = f.session.prompt("request");
		await entered.promise;
		dispose();
		release.resolve();
		await running;
		expect(f.setup()).toBe(0);
		expect(f.invoked()).toBe(0);
		expect(f.faux.state.callCount).toBe(0);
		expect(f.coordinator.inspectEvent(event)?.state).toBe("read");
		expect(f.events).toHaveLength(1);
		expectSuppressedAtRoot(f);
	});

	it("cancels existing warming while bound and warms only a new unbound request", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let hold = false;
		const f = await fixture((pi) => {
			pi.on("cache_warming_decision", () => ({ action: "warm" }));
			pi.on("before_provider_request", async () => {
				if (hold) {
					entered.resolve();
					await release.promise;
				}
			});
		}, "idle");
		fixtures.push(f);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		f.faux.setResponses([
			fauxAssistantMessage("ordinary"),
			fauxAssistantMessage("coordinated"),
			fauxAssistantMessage("new ordinary"),
			fauxAssistantMessage("warm"),
		]);
		await f.session.prompt("ordinary");
		expect(f.session.cacheWarmingStatus?.nextWarmAt).toBeGreaterThan(Date.now());
		const event = f.coordinator.seedEvent("warm", "WARM_PRIVATE");
		const dispose = f.session.requestAdmission.bind(f.coordinator);
		expect(f.session.settingsManager.getCacheWarmingMode()).toBe("idle");
		hold = true;
		const running = f.session.prompt("bound");
		await entered.promise;
		await vi.advanceTimersByTimeAsync(270_000);
		expect(f.setup()).toBe(2);
		expect(f.invoked()).toBe(1);
		release.resolve();
		await running;
		expect(f.invoked()).toBe(2);
		expect(f.coordinator.inspectEvent(event)?.state).toBe("read");
		await vi.advanceTimersByTimeAsync(270_000);
		expect(f.setup()).toBe(2);
		expect(f.faux.state.callCount).toBe(2);
		hold = false;
		dispose();
		await f.session.prompt("new ordinary");
		expect(f.setup()).toBe(3);
		await vi.advanceTimersByTimeAsync(270_000);
		expect(f.setup()).toBe(4);
		expect(f.invoked()).toBe(4);
		expect(f.faux.state.callCount).toBe(4);
	});

	it("warms a busy unbound request but not a busy bound request in streaming mode", async () => {
		let entered = Promise.withResolvers<void>();
		let release = Promise.withResolvers<void>();
		let holdNext = true;
		const f = await fixture((pi) => {
			pi.on("cache_warming_decision", () => ({ action: "warm" }));
			pi.on("before_provider_request", async () => {
				if (holdNext) {
					holdNext = false;
					entered.resolve();
					await release.promise;
				}
			});
		}, "streaming");
		fixtures.push(f);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		f.faux.setResponses(Array.from({ length: 5 }, () => fauxAssistantMessage("done")));
		const ordinary = f.session.prompt("ordinary");
		await entered.promise;
		await vi.advanceTimersByTimeAsync(270_000);
		expect(f.invoked()).toBe(1);
		release.resolve();
		await ordinary;
		const dispose = f.session.requestAdmission.bind(f.coordinator);
		expect(f.session.settingsManager.getCacheWarmingMode()).toBe("streaming");
		entered = Promise.withResolvers<void>();
		release = Promise.withResolvers<void>();
		holdNext = true;
		const bound = f.session.prompt("bound");
		await entered.promise;
		const before = f.invoked();
		await vi.advanceTimersByTimeAsync(270_000);
		expect(f.invoked()).toBe(before);
		release.resolve();
		await bound;
		dispose();
		entered = Promise.withResolvers<void>();
		release = Promise.withResolvers<void>();
		holdNext = true;
		const next = f.session.prompt("new ordinary");
		await entered.promise;
		const resumed = f.invoked();
		await vi.advanceTimersByTimeAsync(270_000);
		expect(f.invoked()).toBe(resumed + 1);
		release.resolve();
		await next;
	});

	it.each(["headers", "payload"] as const)(
		"fences an old warm request held in %s across bind and dispose",
		async (gate) => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let hold = false;
			const f = await fixture((pi) => {
				pi.on("cache_warming_decision", () => ({ action: "warm" }));
				pi.on("before_provider_headers", async () => {
					if (hold && gate === "headers") {
						entered.resolve();
						await release.promise;
					}
				});
				pi.on("before_provider_request", async () => {
					if (hold && gate === "payload") {
						entered.resolve();
						await release.promise;
					}
				});
			}, "idle");
			fixtures.push(f);
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
			f.faux.setResponses([
				fauxAssistantMessage("first"),
				fauxAssistantMessage("new"),
				fauxAssistantMessage("warm"),
			]);
			await f.session.prompt("first");
			hold = true;
			await vi.advanceTimersByTimeAsync(270_000);
			await entered.promise;
			const dispose = f.session.requestAdmission.bind(f.coordinator);
			dispose();
			hold = false;
			await f.session.prompt("new");
			const setup = f.setup();
			const invoked = f.invoked();
			const calls = f.faux.state.callCount;
			release.resolve();
			await vi.advanceTimersByTimeAsync(1);
			expect(f.setup()).toBe(setup);
			expect(f.invoked()).toBe(invoked);
			expect(f.faux.state.callCount).toBe(calls);
			await vi.advanceTimersByTimeAsync(270_000);
			expect(f.invoked()).toBe(invoked + 1);
			expect(f.faux.state.callCount).toBe(calls + 1);
		},
	);

	it("does not dispatch a pre-existing warm request held in auth when binding starts", async () => {
		const f = await fixture((pi) => {
			pi.on("cache_warming_decision", () => ({ action: "warm" }));
		}, "idle");
		fixtures.push(f);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		f.faux.setResponses([fauxAssistantMessage("ordinary"), fauxAssistantMessage("unexpected warm")]);
		await f.session.prompt("ordinary");
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const original = f.runtime.getAuth.bind(f.runtime);
		vi.spyOn(f.runtime, "getAuth").mockImplementation(async (...args) => {
			entered.resolve();
			await release.promise;
			return original(...args);
		});
		await vi.advanceTimersByTimeAsync(270_000);
		await entered.promise;
		const dispose = f.session.requestAdmission.bind(f.coordinator);
		release.resolve();
		await vi.advanceTimersByTimeAsync(1);
		expect(f.setup()).toBe(1);
		expect(f.invoked()).toBe(1);
		expect(f.faux.state.callCount).toBe(1);
		dispose();
	});

	it("allows ordinary unbound payload mutation", async () => {
		const f = await fixture((pi) => {
			pi.on("before_provider_request", (event) => {
				if (event.payload && typeof event.payload === "object") Object.assign(event.payload, { changed: true });
			});
		});
		fixtures.push(f);
		await f.session.prompt("request");
		expect(f.invoked()).toBe(1);
		expect(f.faux.state.callCount).toBe(1);
		expect(f.payloads[0]).toMatchObject({ changed: true });
	});
});
