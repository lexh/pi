import { readFileSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it, vi } from "vitest";
import { RuntimeDisposedError } from "../../src/core/agent-session-coordination.ts";
import type { ExtensionAPI, ExtensionFactory } from "../../src/core/extensions/types.ts";
import { getProcessRuntimeHost } from "../../src/core/runtime-host.ts";
import type { HostRuntimeImage, RuntimeExchange } from "../../src/core/runtime-lifecycle-types.ts";
import { savedFixture } from "../helpers/external-events.ts";
import { FakeRequestCoordinator } from "../helpers/fake-request-coordinator.ts";
import { FakeRuntimeCoordinator } from "../helpers/fake-runtime-coordinator.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createHarness as createBaseHarness, type HarnessOptions } from "./harness.ts";

async function createHarness(options: HarnessOptions) {
	const harness = await createBaseHarness(options);
	harness.faux.setResponses([]);
	const streamInvocations: number[] = [];
	const stream = harness.session.agent.streamFunction;
	harness.session.agent.streamFunction = (...args) => {
		streamInvocations.push(1);
		return stream(...args);
	};
	const cleanup = harness.cleanup;
	harness.cleanup = () => {
		try {
			expect(harness.faux.state.callCount).toBe(0);
			expect(harness.eventsOfType("agent_start")).toEqual([]);
			expect(streamInvocations).toEqual([]);
		} finally {
			cleanup();
		}
	};
	return harness;
}

describe("runtime reload", () => {
	it.each(["committed", "preparation"] as const)(
		"rejects reload while %s work is held and leaves its scope current",
		async (phase) => {
			const f = savedFixture();
			const apis: ExtensionAPI[] = [];
			const shutdowns: string[] = [];
			const factory: ExtensionFactory = (pi) => {
				apis.push(pi);
				pi.on("session_shutdown", (event) => {
					shutdowns.push(event.reason);
				});
			};
			let extensions = await createTestExtensionsResult([factory], f.directory);
			const loader = {
				...createTestResourceLoader(),
				getExtensions: () => extensions,
				reload: async () => {
					extensions = await createTestExtensionsResult([factory], f.directory);
				},
			};
			const h = await createBaseHarness({ sessionManager: f.manager, resourceLoader: loader });
			const authority = new FakeRuntimeCoordinator();
			try {
				h.session.refreshContext();
				await h.session.bindExtensions({});
				const oldLifecycle = h.session.runtimeLifecycle;
				oldLifecycle.participate();
				await oldLifecycle.reconcile(authority.exchange);
				const fence = oldLifecycle.capture();
				const oldOwner = apis[0].requestAdmission;
				const oldContext = h.session.extensionRunner.createContext();
				expect(oldContext.requestAdmission).toBe(oldOwner);
				const coordinator = new FakeRequestCoordinator(authority, undefined, undefined, fence.mailboxId);
				const event = coordinator.seedEvent(`reload-${phase}`, "RELOAD_PRIVATE");
				coordinator.seedMatchingConsumption(event, "claim");
				const dispose = oldOwner.bind(coordinator);
				const gate = phase === "committed" ? coordinator.holdNextAdmission() : undefined;
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				if (phase === "preparation") {
					const original = coordinator.snapshot.bind(coordinator);
					vi.spyOn(coordinator, "snapshot").mockImplementation(async (...args) => {
						entered.resolve();
						await release.promise;
						return original(...args);
					});
				}
				const admit = vi.spyOn(coordinator, "admit");
				h.faux.setResponses([fauxAssistantMessage("old request done")]);
				const running = h.session.prompt("old request");
				if (gate) {
					await gate.received;
					gate.commit();
					await gate.committed;
				} else await entered.promise;
				await expect(h.session.reload()).rejects.toThrow(
					"Wait for the current response to finish before reloading.",
				);
				expect(oldLifecycle.isCurrent(fence)).toBe(true);
				expect(h.session.requestAdmission).toBe(oldOwner);
				expect(oldContext.requestAdmission).toBe(oldOwner);
				expect(apis).toHaveLength(1);
				expect(shutdowns).toEqual([]);
				if (gate) gate.respond();
				else release.resolve();
				await running;
				expect(admit).toHaveBeenCalledTimes(1);
				expect(h.faux.state.callCount).toBe(1);
				expect(oldLifecycle.isCurrent(fence)).toBe(true);

				await h.session.reload();
				expect(oldLifecycle.isCurrent(fence)).toBe(false);
				expect(shutdowns).toEqual(["reload"]);
				expect(h.session.requestAdmission).not.toBe(oldOwner);
				expect(() => apis[0].requestAdmission).toThrow(/stale/i);
				expect(() => oldContext.requestAdmission).toThrow(/stale/i);
				expect(() => oldOwner.bind(coordinator)).toThrow();
				expect(apis[1].requestAdmission).toBe(h.session.requestAdmission);
				dispose();
			} finally {
				h.cleanup();
				f.cleanup();
			}
		},
	);
	it("reload rotates one scope without restoring any resource or making a request", async () => {
		const f = savedFixture();
		let extensionsResult = await createTestExtensionsResult([], f.directory);
		const loader = {
			...createTestResourceLoader(),
			getExtensions: () => extensionsResult,
			reload: async () => {
				extensionsResult = await createTestExtensionsResult([], f.directory);
			},
		};
		const h = await createHarness({ sessionManager: f.manager, resourceLoader: loader });
		const fake = new FakeRuntimeCoordinator();
		try {
			const priorFacade = h.session.runtimeLifecycle;
			priorFacade.participate();
			await priorFacade.reconcile(fake.exchange);
			const prior = priorFacade.capture();
			const revoked: string[] = [];
			for (const kind of ["wait", "grant", "claim"] as const) {
				priorFacade.track(prior, { kind, id: kind, revoke: (reason) => revoked.push(reason) });
			}
			const leaf = f.manager.getLeafId();
			await h.session.reload();
			const nextFacade = h.session.runtimeLifecycle;
			nextFacade.participate();
			await nextFacade.reconcile(fake.exchange);
			const next = nextFacade.capture();
			expect(next.hostId).toBe(prior.hostId);
			expect(next.mailboxId).toBe(prior.mailboxId);
			expect(next.instanceId).not.toBe(prior.instanceId);
			expect(next.incarnation).toBeGreaterThan(prior.incarnation);
			expect(priorFacade.isCurrent(prior)).toBe(false);
			expect(revoked).toEqual(["runtime-detached", "runtime-detached", "runtime-detached"]);
			expect(f.manager.getLeafId()).toBe(leaf);
			expect(h.faux.state.callCount).toBe(0);
			expect(h.eventsOfType("agent_start")).toEqual([]);
		} finally {
			h.cleanup();
			f.cleanup();
		}
	});

	it("keeps a second SDK scope live through two offline reloads and a late reply", async () => {
		const f = savedFixture();
		const other = savedFixture();
		let extensions = await createTestExtensionsResult([], f.directory);
		const loader = {
			...createTestResourceLoader(),
			getExtensions: () => extensions,
			reload: async () => {
				extensions = await createTestExtensionsResult([], f.directory);
			},
		};
		const h = await createHarness({ sessionManager: f.manager, resourceLoader: loader });
		const sibling = await createHarness({ sessionManager: other.manager });
		const fake = new FakeRuntimeCoordinator();
		const images: HostRuntimeImage[] = [];
		const exchange: RuntimeExchange = async (image, authentication) => {
			const receipt = await fake.exchange(image, authentication);
			images.push(structuredClone(image));
			return receipt;
		};
		try {
			const old = h.session.runtimeLifecycle;
			old.participate();
			sibling.session.runtimeLifecycle.participate();
			await old.reconcile(exchange);
			await sibling.session.runtimeLifecycle.reconcile(exchange);
			const first = old.capture();
			const siblingFence = sibling.session.runtimeLifecycle.capture();
			const held = fake.holdNextExchange();
			const delayed = old.reconcile(fake.exchange);
			await held.received;
			held.commit();
			await held.committed;
			fake.disconnect();
			const bytes = readFileSync(f.manager.getSessionFile()!);
			await h.session.reload();
			const middle = h.session.runtimeLifecycle;
			middle.participate();
			await expect(middle.reconcile(exchange)).rejects.toThrow("Coordinator disconnected");
			const inspection = middle.inspect();
			if (inspection.state === "unavailable") throw new Error("Middle runtime unavailable");
			const middleId = inspection.instanceId;
			expect(fake.attachmentFor(siblingFence.mailboxId)?.instanceId).toBe(siblingFence.instanceId);
			await h.session.reload();
			const current = h.session.runtimeLifecycle;
			current.participate();
			fake.reconnect();
			await current.reconcile(exchange);
			const finalImage = images.at(-1)!;
			held.respond();
			expect(await delayed).toBe("superseded");
			const next = current.capture();
			expect(next.hostId).toBe(first.hostId);
			expect(next.mailboxId).toBe(first.mailboxId);
			expect(next.incarnation).toBeGreaterThan(first.incarnation + 1);
			expect(next.generation).toBe(first.generation + 1);
			expect(finalImage.runtimes.map((item) => item.instanceId)).toContain(siblingFence.instanceId);
			expect(finalImage.runtimes.map((item) => item.instanceId)).toContain(next.instanceId);
			expect(finalImage.runtimes.map((item) => item.instanceId)).not.toContain(middleId);
			expect(fake.attachmentFor(siblingFence.mailboxId)?.instanceId).toBe(siblingFence.instanceId);
			expect(next.instanceId).not.toBe(first.instanceId);
			expect(old.isCurrent(first)).toBe(false);
			// The failed shared exchange invalidates the sibling's local route, not its remote attachment.
			expect(sibling.session.runtimeLifecycle.isCurrent(siblingFence)).toBe(false);
			await sibling.session.runtimeLifecycle.reconcile(exchange);
			const verifiedSibling = sibling.session.runtimeLifecycle.capture();
			expect(verifiedSibling.instanceId).toBe(siblingFence.instanceId);
			expect(verifiedSibling.generation).toBe(siblingFence.generation);
			expect(readFileSync(f.manager.getSessionFile()!)).toEqual(bytes);
			expect(h.faux.state.callCount).toBe(0);
			expect(h.eventsOfType("agent_start")).toEqual([]);
		} finally {
			h.cleanup();
			sibling.cleanup();
			f.cleanup();
			other.cleanup();
		}
	});

	it("uses an unavailable facade if successor allocation fails", async () => {
		const f = savedFixture();
		let extensions = await createTestExtensionsResult([], f.directory);
		const loader = {
			...createTestResourceLoader(),
			getExtensions: () => extensions,
			reload: async () => {
				extensions = await createTestExtensionsResult([], f.directory);
			},
		};
		const h = await createHarness({ sessionManager: f.manager, resourceLoader: loader });
		const fake = new FakeRuntimeCoordinator();
		try {
			const old = h.session.runtimeLifecycle;
			old.participate();
			await old.reconcile(fake.exchange);
			const fence = old.capture();
			const spy = vi.spyOn(getProcessRuntimeHost(), "open").mockImplementationOnce(() => {
				throw new Error("allocation failed");
			});
			try {
				await h.session.reload();
			} finally {
				spy.mockRestore();
			}
			expect(h.session.runtimeLifecycle.inspect()).toEqual({ state: "unavailable", reason: "allocation failed" });
			expect(old.isCurrent(fence)).toBe(false);
			await h.session.reload();
			const next = h.session.runtimeLifecycle;
			next.participate();
			await next.reconcile(fake.exchange);
			expect(next.capture().hostId).toBe(fence.hostId);
			expect(next.capture().mailboxId).toBe(fence.mailboxId);
			expect(next.capture().incarnation).toBeGreaterThan(fence.incarnation);
		} finally {
			h.cleanup();
			f.cleanup();
		}
	});

	it("does not restore a retired scope after loader failure and recovers on retry", async () => {
		const f = savedFixture();
		let extensions = await createTestExtensionsResult([], f.directory);
		let fail = true;
		const loader = {
			...createTestResourceLoader(),
			getExtensions: () => extensions,
			reload: async () => {
				if (fail) throw new Error("loader failed");
				extensions = await createTestExtensionsResult([], f.directory);
			},
		};
		const h = await createHarness({ sessionManager: f.manager, resourceLoader: loader });
		try {
			const fake = new FakeRuntimeCoordinator();
			const old = h.session.runtimeLifecycle;
			old.participate();
			await old.reconcile(fake.exchange);
			const fence = old.capture();
			await expect(h.session.reload()).rejects.toThrow("loader failed");
			expect(h.session.runtimeLifecycle).toBe(old);
			expect(old.isCurrent(fence)).toBe(false);
			fail = false;
			await h.session.reload();
			const next = h.session.runtimeLifecycle;
			next.participate();
			await next.reconcile(fake.exchange);
			expect(next.capture().incarnation).toBeGreaterThan(fence.incarnation);
			expect(next.capture().mailboxId).toBe(fence.mailboxId);
			expect(h.faux.state.callCount).toBe(0);
		} finally {
			h.cleanup();
			f.cleanup();
		}
	});

	it.each(["loader", "beforeSessionStart"] as const)(
		"disposal while %s is paused prevents later startup",
		async (phase) => {
			const f = savedFixture();
			let extensions = await createTestExtensionsResult([], f.directory);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const loader = {
				...createTestResourceLoader(),
				getExtensions: () => extensions,
				reload: async () => {
					if (phase === "loader") {
						entered.resolve();
						await release.promise;
					}
					extensions = await createTestExtensionsResult([], f.directory);
				},
			};
			const h = await createHarness({ sessionManager: f.manager, resourceLoader: loader });
			try {
				await h.session.bindExtensions({ onError: () => {} });
				const old = h.session.runtimeLifecycle;
				const pending = h.session.reload({
					beforeSessionStart: async () => {
						if (phase === "beforeSessionStart") {
							entered.resolve();
							await release.promise;
						}
					},
				});
				const rejected = expect(pending).rejects.toBeInstanceOf(RuntimeDisposedError);
				await entered.promise;
				const facade = h.session.runtimeLifecycle;
				h.session.dispose();
				release.resolve();
				await rejected;
				if (phase === "loader") expect(h.session.runtimeLifecycle).toBe(old);
				else expect(facade.inspect().state).toBe("retired");
				expect(h.faux.state.callCount).toBe(0);
				expect(h.eventsOfType("agent_start")).toEqual([]);
			} finally {
				h.cleanup();
				f.cleanup();
			}
		},
	);

	it("disposal during resource discovery prevents late resource extension", async () => {
		const f = savedFixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let extensions = await createTestExtensionsResult([], f.directory);
		const extendResources = vi.fn();
		const loader = {
			...createTestResourceLoader(),
			getExtensions: () => extensions,
			extendResources,
			reload: async () => {
				extensions = await createTestExtensionsResult(
					[
						(pi) => {
							pi.on("resources_discover", async () => {
								entered.resolve();
								await release.promise;
								return { skillPaths: ["late"] };
							});
						},
					],
					f.directory,
				);
			},
		};
		const h = await createHarness({ sessionManager: f.manager, resourceLoader: loader });
		try {
			await h.session.bindExtensions({ onError: () => {} });
			const reload = h.session.reload();
			const rejected = expect(reload).rejects.toBeInstanceOf(RuntimeDisposedError);
			await entered.promise;
			h.session.dispose();
			release.resolve();
			await rejected;
			expect(extendResources).not.toHaveBeenCalled();
			expect(h.faux.state.callCount).toBe(0);
		} finally {
			h.cleanup();
			f.cleanup();
		}
	});

	it("repeated binds do not rotate and direct disposal retires the facade", async () => {
		const f = savedFixture();
		const h = await createHarness({ sessionManager: f.manager });
		try {
			const facade = h.session.runtimeLifecycle;
			facade.participate();
			await facade.reconcile(new FakeRuntimeCoordinator().exchange);
			const fence = facade.capture();
			await h.session.bindExtensions({});
			await h.session.bindExtensions({});
			expect(h.session.runtimeLifecycle).toBe(facade);
			expect(facade.isCurrent(fence)).toBe(true);
			h.session.dispose();
			expect(facade.isCurrent(fence)).toBe(false);
			expect(facade.inspect().state).toBe("retired");
		} finally {
			h.cleanup();
			f.cleanup();
		}
	});
});
