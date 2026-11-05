import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeDisposedError, RuntimeReplacementInProgressError } from "../../src/core/agent-session-coordination.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { readExternalEntry } from "../../src/core/external-event-records.ts";
import { resolveConversationBinding } from "../../src/core/runtime-incarnation.ts";
import type { HostRuntimeImage, RuntimeExchange } from "../../src/core/runtime-lifecycle-types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { AgentToolResult, ExtensionAPI, ExtensionContext, ExtensionFactory } from "../../src/index.ts";
import {
	ADMITTED_BODY,
	admission,
	canonical,
	PENDING_BODY,
	selectSyntheticAdmission,
} from "../helpers/external-events.ts";
import { FakeRequestCoordinator } from "../helpers/fake-request-coordinator.ts";
import { FakeRuntimeCoordinator } from "../helpers/fake-runtime-coordinator.ts";
import { userMsg } from "../utilities.ts";

describe("AgentSessionRuntime characterization", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeForTest(
		extensionFactory: ExtensionFactory,
		options?: {
			cwd?: string;
			bootstrapModel?: boolean;
			bootstrapThinkingLevel?: boolean;
			autoBind?: boolean;
			beforeCreate?: () => Promise<void>;
			expectedDisposeError?: Error;
			afterCreate?: (
				session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"],
			) => Promise<void>;
		},
	) {
		const tempDir =
			options?.cwd ?? join(tmpdir(), `pi-runtime-suite-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [
				{ id: "faux-1", reasoning: true },
				{ id: "faux-2", reasoning: false },
			],
		});
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: options?.bootstrapModel === false ? undefined : faux.getModel(),
			thinkingLevel: options?.bootstrapThinkingLevel === false ? undefined : undefined,
			resourceLoaderOptions: {
				extensionFactories: [
					(pi: ExtensionAPI) => {
						pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((registeredModel) => ({
								id: registeredModel.id,
								name: registeredModel.name,
								api: registeredModel.api,
								reasoning: registeredModel.reasoning,
								input: registeredModel.input,
								cost: registeredModel.cost,
								contextWindow: registeredModel.contextWindow,
								maxTokens: registeredModel.maxTokens,
							})),
						});
						extensionFactory(pi);
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const agentStarts: string[] = [];
		const streamInvocations: string[] = [];
		const sessions: Array<Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"]> = [];
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			await options?.beforeCreate?.();
			const services = await createAgentSessionServices({ ...runtimeOptions, cwd });
			const result = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: runtimeOptions.model,
				thinkingLevel: runtimeOptions.thinkingLevel,
			});
			const session = result.session;
			sessions.push(session);
			session.subscribe((event) => {
				if (event.type === "agent_start") agentStarts.push(session.sessionId);
			});
			const stream = session.agent.streamFunction;
			session.agent.streamFunction = (...args) => {
				streamInvocations.push(session.sessionId);
				return stream(...args);
			};
			await options?.afterCreate?.(session);
			return { ...result, services, diagnostics: services.diagnostics };
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
		});
		const extensionErrors: string[] = [];
		if (options?.autoBind) {
			const bind = async (session: typeof runtime.session) => {
				await session.bindExtensions({ onError: (error) => extensionErrors.push(error.error) });
			};
			runtime.setRebindSession(bind);
			await bind(runtime.session);
		} else {
			await runtime.session.bindExtensions({});
		}

		cleanups.push(async () => {
			if (options?.expectedDisposeError) await expect(runtime.dispose()).rejects.toBe(options.expectedDisposeError);
			else await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtime, faux, tempDir, sessions, agentStarts, streamInvocations, extensionErrors };
	}

	it("retires a committed old request before replacing it with a new saved conversation", async () => {
		const apis: ExtensionAPI[] = [];
		const contexts: ExtensionContext[] = [];
		const { runtime, faux, agentStarts, streamInvocations } = await createRuntimeForTest(
			(pi) => {
				apis.push(pi);
				pi.on("session_start", (_event, ctx) => {
					contexts.push(ctx);
				});
			},
			{ autoBind: true },
		);
		const old = runtime.session;
		const authority = new FakeRuntimeCoordinator();
		old.runtimeLifecycle.participate();
		await old.runtimeLifecycle.reconcile(authority.exchange);
		const fence = old.runtimeLifecycle.capture();
		const oldFacade = apis[0].requestAdmission;
		const oldContext = contexts[0];
		const coordinator = new FakeRequestCoordinator(authority, undefined, undefined, fence.mailboxId);
		const event = coordinator.seedEvent("replacement-commit", "REPLACEMENT_COMMITTED_PRIVATE");
		coordinator.seedMatchingConsumption(event, "claim");
		const dispose = oldFacade.bind(coordinator);
		const gate = coordinator.holdNextAdmission();
		const admit = vi.spyOn(coordinator, "admit");
		const running = old.prompt("old request");
		await gate.received;
		gate.commit();
		await gate.committed;
		const root = old.sessionManager.getLeafId();
		const file = old.sessionFile!;
		const request = coordinator.inspectRequest(admit.mock.calls[0][0].request.requestId)!;
		const retired = Promise.withResolvers<void>();
		const retire = old.retireRuntime.bind(old);
		vi.spyOn(old, "retireRuntime").mockImplementation((...args) => {
			retire(...args);
			retired.resolve();
		});
		const replacement = runtime.newSession();
		await retired.promise;
		const retiredFence = old.runtimeLifecycle.isCurrent(fence);
		const sameDuringRetirement = runtime.session === old;
		gate.respond();
		await Promise.all([running, replacement]);
		expect(retiredFence).toBe(false);
		expect(sameDuringRetirement).toBe(true);
		const current = runtime.session;
		expect(current).not.toBe(old);
		current.sessionManager.persistNow();
		expect(current.sessionFile).not.toBe(file);
		expect(SessionManager.open(file).getLeafId()).toBe(root);
		expect(old.sessionManager.getEntry(request.result.entries[0].entryId)).toBeUndefined();
		expect(coordinator.inspectEvent(event)?.state).toBe("read");
		expect(coordinator.inspectConsumption(event)).toBeNull();
		expect(coordinator.inspectRequest(request.result.requestId)?.suppressed).toBe(true);
		expect(() => apis[0].requestAdmission).toThrow(/stale/i);
		expect(() => oldContext.requestAdmission).toThrow(/stale/i);
		expect(() => oldFacade.bind(coordinator)).toThrow();
		expect(() => oldFacade.stageCompletedWait(event, fence)).toThrow();
		await expect(oldFacade.reconcile()).rejects.toThrow();
		current.runtimeLifecycle.participate();
		await current.runtimeLifecycle.reconcile(authority.exchange);
		const fresh = apis[1].requestAdmission;
		expect(contexts[1].requestAdmission).toBe(fresh);
		const freshFence = current.runtimeLifecycle.capture();
		const freshCoordinator = new FakeRequestCoordinator(authority, undefined, undefined, freshFence.mailboxId);
		const freshDispose = fresh.bind(freshCoordinator);
		dispose();
		expect(current.isRequestAdmissionBound).toBe(true);
		expect(agentStarts).toHaveLength(1);
		expect(streamInvocations).toHaveLength(0);
		expect(faux.state.callCount).toBe(0);
		const newRoot = current.sessionManager.getLeafId();
		expect(SessionManager.open(current.sessionFile!).getLeafId()).toBe(newRoot);
		faux.setResponses([fauxAssistantMessage("new result")]);
		await current.prompt("new explicit request");
		expect(faux.state.callCount).toBe(1);
		freshDispose();
	});

	it.each(["reported", "report-failed"] as const)(
		"does not materialize a late commit while replacement waits (%s)",
		async (report) => {
			const switchEntered = Promise.withResolvers<void>();
			const releaseSwitch = Promise.withResolvers<void>();
			const { runtime, faux, agentStarts, streamInvocations } = await createRuntimeForTest(
				(pi) => {
					pi.on("session_before_switch", async () => {
						switchEntered.resolve();
						await releaseSwitch.promise;
					});
				},
				{ autoBind: true },
			);
			const old = runtime.session;
			const authority = new FakeRuntimeCoordinator();
			old.runtimeLifecycle.participate();
			await old.runtimeLifecycle.reconcile(authority.exchange);
			const fence = old.runtimeLifecycle.capture();
			const coordinator = new FakeRequestCoordinator(authority, undefined, undefined, fence.mailboxId);
			const event = coordinator.seedEvent("pre-retirement-commit", "PRIVATE_COMMIT");
			coordinator.seedMatchingConsumption(event, "claim");
			old.requestAdmission.bind(coordinator);
			const suppressed = vi.spyOn(coordinator, "suppressed");
			if (report === "report-failed") suppressed.mockRejectedValue(new Error("receipt unavailable"));
			const exits: string[] = [];
			old.subscribe((value) => {
				if (value.type === "request_suppressed") exits.push(value.reason);
			});
			const gate = coordinator.holdNextAdmission();
			const admit = vi.spyOn(coordinator, "admit");
			const running = old.prompt("old request");
			await gate.received;
			gate.commit();
			await gate.committed;
			const root = old.sessionManager.getLeafId();
			const request = coordinator.inspectRequest(admit.mock.calls[0][0].request.requestId)!;
			const replacement = runtime.newSession();
			await switchEntered.promise;
			gate.respond();
			await running;
			const entry = old.sessionManager.getEntry(request.result.entries[0].entryId);
			const selected = old.sessionManager.getLeafId();
			releaseSwitch.resolve();
			await replacement;
			expect(entry).toBeUndefined();
			expect(selected).toBe(root);
			expect(coordinator.inspectEvent(event)?.state).toBe("read");
			expect(coordinator.inspectConsumption(event)).toBeNull();
			expect(suppressed).toHaveBeenCalledExactlyOnceWith(request.result.requestId);
			expect(coordinator.inspectRequest(request.result.requestId)?.suppressed).toBe(report === "reported");
			expect(exits).toEqual(["coordination-stale"]);
			expect(agentStarts).toHaveLength(1);
			expect(streamInvocations).toHaveLength(0);
			expect(faux.state.callCount).toBe(0);
		},
	);

	it("does not admit old work while a real new-session replacement is awaiting its switch hook", async () => {
		const switchEntered = Promise.withResolvers<void>();
		const releaseSwitch = Promise.withResolvers<void>();
		const { runtime, faux, agentStarts, streamInvocations } = await createRuntimeForTest(
			(pi) => {
				pi.on("session_before_switch", async () => {
					switchEntered.resolve();
					await releaseSwitch.promise;
				});
			},
			{ autoBind: true },
		);
		const old = runtime.session;
		const authority = new FakeRuntimeCoordinator();
		old.runtimeLifecycle.participate();
		await old.runtimeLifecycle.reconcile(authority.exchange);
		const fence = old.runtimeLifecycle.capture();
		const coordinator = new FakeRequestCoordinator(authority, undefined, undefined, fence.mailboxId);
		const event = coordinator.seedEvent("replacement-gate", "REPLACEMENT_PRIVATE");
		old.requestAdmission.bind(coordinator);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const original = coordinator.workspace.bind(coordinator);
		vi.spyOn(coordinator, "workspace").mockImplementation(async (...args) => {
			entered.resolve();
			await release.promise;
			return original(...args);
		});
		const admit = vi.spyOn(coordinator, "admit");
		const running = old.prompt("old request");
		await entered.promise;
		const replacement = runtime.newSession();
		await switchEntered.promise;
		expect(old.isReplacementInProgress).toBe(true);
		release.resolve();
		await running;
		const calls = admit.mock.calls.length;
		const streams = streamInvocations.length;
		const modelCalls = faux.state.callCount;
		releaseSwitch.resolve();
		await replacement;
		expect(calls).toBe(0);
		expect(streams).toBe(0);
		expect(modelCalls).toBe(0);
		expect(agentStarts).toHaveLength(1);
		expect(coordinator.inspectEvent(event)?.state).toBe("pending");
	});

	it("same-PID offline handover preserves canonical history and fences the old runtime", async () => {
		const fake = new FakeRuntimeCoordinator();
		const facades: ReturnType<ExtensionAPI["getRuntimeLifecycle"]>[] = [];
		const outcomes: string[] = [];
		const shutdownEntered = Promise.withResolvers<void>();
		const releaseShutdown = Promise.withResolvers<void>();
		const originalPid = process.pid;
		const { runtime, faux, agentStarts, streamInvocations, extensionErrors } = await createRuntimeForTest(
			(pi) => {
				pi.on("session_start", async () => {
					const facade = pi.getRuntimeLifecycle();
					facades.push(facade);
					facade.participate();
					try {
						outcomes.push(await facade.reconcile(fake.exchange));
					} catch (error) {
						if (!(error instanceof Error) || error.message !== "Coordinator disconnected") throw error;
						facade.disconnect();
						outcomes.push("disconnected");
					}
				});
				pi.on("session_shutdown", async (event) => {
					if (event.reason === "reload") {
						shutdownEntered.resolve();
						await releaseShutdown.promise;
					}
					if (event.reason === "quit") await pi.getRuntimeLifecycle().reconcile(fake.exchange);
				});
			},
			{ autoBind: true },
		);
		faux.setResponses([]);
		const session = runtime.session;
		const manager = session.sessionManager;
		const outgoingFacade = facades[0];
		const old = outgoingFacade.capture();
		const root = manager.appendMessage(userMsg("branch root"));
		manager.appendMessage(userMsg("unselected branch"));
		manager.branch(root);
		const selected = manager.appendMessage(userMsg("SELECTED_BRANCH_SENTINEL"));
		const pending = { ...canonical("pending"), recipientIdentity: old.mailboxId };
		manager.appendEntryOnce(pending, root);
		const admitted = {
			...admission({ ...canonical("admitted"), recipientIdentity: old.mailboxId }, selected),
			instanceId: old.instanceId,
			epoch: old.epoch,
		};
		selectSyntheticAdmission(manager, admitted);
		const selectedSibling = manager.appendMessage(userMsg("selected leaf"));
		session.refreshContext();
		const contextBefore = JSON.stringify(session.messages);
		expect(contextBefore).toContain("SELECTED_BRANCH_SENTINEL");
		expect(contextBefore).toContain(ADMITTED_BODY);
		expect(contextBefore).not.toContain(PENDING_BODY);
		const entries = manager
			.getEntries()
			.map(readExternalEntry)
			.filter((record) => record !== undefined);
		expect(entries.filter((record) => record.kind === "canonical")).toHaveLength(1);
		expect(entries.filter((record) => record.kind === "admission")).toEqual([admitted]);
		const cards = () => session.getExternalEventView().filter((item) => item.type === "external_event");
		expect(
			cards()
				.map((card) => card.record.eventId)
				.sort(),
		).toEqual(["admitted", "pending"]);
		const bytes = readFileSync(manager.getSessionFile()!);
		fake.seedOwnedWork(old.mailboxId, "owned-work");
		const revoked: string[] = [];
		for (const kind of ["wait", "grant", "claim"] as const) {
			outgoingFacade.track(old, { kind, id: kind, revoke: () => revoked.push(kind) });
			fake.operate(old, kind, kind);
		}
		fake.watchExit(old, "outgoing-instance");
		const held = fake.holdOperation(old, "late-response", "status");
		await held.received;
		held.commit();
		await held.committed;
		let lateContinuations = 0;
		const delivery = held.response.then(() => {
			if (outgoingFacade.isCurrent(old)) lateContinuations++;
		});
		fake.disconnect();
		await expect(outgoingFacade.reconcile(fake.exchange)).rejects.toThrow("Coordinator disconnected");
		outgoingFacade.disconnect();
		const reload = session.reload();
		await shutdownEntered.promise;
		try {
			expect(outgoingFacade.isCurrent(old)).toBe(false);
			expect(revoked).toEqual(["wait", "grant", "claim"]);
		} finally {
			releaseShutdown.resolve();
		}
		await reload;
		const successor = facades[1];
		expect(successor).not.toBe(outgoingFacade);
		expect(() => successor.capture()).toThrow();
		expect(outcomes).toEqual(["applied", "disconnected"]);
		fake.reconnect();
		expect(await successor.reconcile(fake.exchange)).toBe("applied");
		const current = successor.capture();
		held.respond();
		await delivery;
		expect(lateContinuations).toBe(0);
		for (const kind of ["wait", "grant", "claim", "status"] as const)
			expect(() => fake.operate(old, `stale-${kind}`, kind)).toThrow(/stale/);
		expect(process.pid).toBe(originalPid);
		expect(current.hostId).toBe(old.hostId);
		expect(current.instanceId).not.toBe(old.instanceId);
		expect(current.incarnation).toBeGreaterThan(old.incarnation);
		expect(current.generation).toBeGreaterThan(old.generation);
		expect(current.mailboxId).toBe(old.mailboxId);
		expect(fake.ownerOf("owned-work")).toBe(old.mailboxId);
		expect(fake.exitResult("outgoing-instance")).toEqual({ reason: "runtime-detached" });
		expect([fake.resourceState("wait"), fake.resourceState("grant"), fake.resourceState("claim")]).toEqual([
			"interrupted",
			"revoked",
			"retired",
		]);
		expect(fake.activeResourcesFor(current)).toEqual([]);
		expect(manager.getLeafId()).toBe(selectedSibling);
		expect(SessionManager.open(manager.getSessionFile()!).getLeafId()).toBe(selectedSibling);
		expect(readFileSync(manager.getSessionFile()!)).toEqual(bytes);
		expect(
			manager
				.getEntries()
				.map(readExternalEntry)
				.filter((record) => record !== undefined),
		).toEqual(entries);
		expect(
			cards()
				.map((card) => card.record.eventId)
				.sort(),
		).toEqual(["admitted", "pending"]);
		session.refreshContext();
		expect(JSON.stringify(session.messages)).toBe(contextBefore);
		expect(faux.state.callCount).toBe(0);
		expect(streamInvocations).toEqual([]);
		expect(agentStarts).toEqual([]);
		expect(extensionErrors).toEqual([]);
	});

	it.each(["new", "resume", "fork-before", "fork-at", "reload"] as const)(
		"replaces via %s online and offline",
		async (kind) => {
			for (const offline of [false, true]) {
				const fake = new FakeRuntimeCoordinator();
				const facades: ReturnType<ExtensionAPI["getRuntimeLifecycle"]>[] = [];
				const { runtime, faux, agentStarts, streamInvocations, extensionErrors } = await createRuntimeForTest(
					(pi) => {
						pi.on("session_start", async () => {
							const facade = pi.getRuntimeLifecycle();
							facades.push(facade);
							facade.participate();
							try {
								await facade.reconcile(fake.exchange);
							} catch (error) {
								if (!(error instanceof Error) || error.message !== "Coordinator disconnected") throw error;
								facade.disconnect();
							}
						});
						pi.on("session_shutdown", async (event) => {
							if (event.reason === "quit") await pi.getRuntimeLifecycle().reconcile(fake.exchange);
						});
					},
					{ autoBind: true },
				);
				faux.setResponses([]);
				const originalSession = runtime.session;
				const source = originalSession.sessionFile!;
				const leaf = originalSession.sessionManager.appendMessage(userMsg("matrix selected"));
				const old = facades[0].capture();
				fake.seedOwnedWork(old.mailboxId, "work");
				if (offline) fake.disconnect();
				if (kind === "new") await runtime.newSession();
				else if (kind === "resume") await runtime.switchSession(source);
				else if (kind === "fork-before") await runtime.fork(leaf, { position: "before" });
				else if (kind === "fork-at") await runtime.fork(leaf, { position: "at" });
				else await runtime.reload();
				const next = facades[1];
				if (offline) {
					expect(() => next.capture()).toThrow();
					fake.reconnect();
					expect(await next.reconcile(fake.exchange)).toBe("applied");
				}
				const current = next.capture();
				expect(current.hostId).toBe(old.hostId);
				expect(current.instanceId).not.toBe(old.instanceId);
				expect(current.incarnation).toBeGreaterThan(old.incarnation);
				if (kind === "resume" || kind === "reload") expect(current.mailboxId).toBe(old.mailboxId);
				else expect(current.mailboxId).not.toBe(old.mailboxId);
				expect(fake.ownerOf("work")).toBe(old.mailboxId);
				expect(facades[0].isCurrent(old)).toBe(false);
				expect(extensionErrors).toEqual([]);
				expect(faux.state.callCount).toBe(0);
				expect(agentStarts).toEqual([]);
				expect(streamInvocations).toEqual([]);
				await runtime.dispose();
			}
		},
	);

	it.each(["new", "resume"] as const)(
		"coalesces offline reload then %s without replaying the intermediate image",
		async (kind) => {
			const fake = new FakeRuntimeCoordinator();
			const images: HostRuntimeImage[] = [];
			const exchange: RuntimeExchange = async (image, authentication) => {
				const receipt = await fake.exchange(image, authentication);
				images.push(structuredClone(image));
				return receipt;
			};
			const facades: ReturnType<ExtensionAPI["getRuntimeLifecycle"]>[] = [];
			const { runtime, faux, agentStarts, streamInvocations, extensionErrors } = await createRuntimeForTest(
				(pi) => {
					pi.on("session_start", async () => {
						const facade = pi.getRuntimeLifecycle();
						facades.push(facade);
						facade.participate();
						try {
							await facade.reconcile(exchange);
						} catch (error) {
							if (!(error instanceof Error) || error.message !== "Coordinator disconnected") throw error;
							facade.disconnect();
						}
					});
					pi.on("session_shutdown", async (event) => {
						if (event.reason === "quit") await pi.getRuntimeLifecycle().reconcile(exchange);
					});
				},
				{ autoBind: true },
			);
			faux.setResponses([]);
			const source = runtime.session.sessionFile!;
			const old = facades[0].capture();
			fake.seedOwnedWork(old.mailboxId, "work");
			fake.disconnect();
			await runtime.reload();
			const middle = facades[1];
			const inspection = middle.inspect();
			if (inspection.state === "unavailable") throw new Error("Middle runtime unavailable");
			const middleId = inspection.instanceId;
			if (kind === "new") await runtime.newSession();
			else await runtime.switchSession(source);
			const final = facades[2];
			expect(() => final.capture()).toThrow();
			expect(images).toHaveLength(1);
			fake.reconnect();
			await final.reconcile(exchange);
			const current = final.capture();
			expect(images).toHaveLength(2);
			expect(images[1].runtimes.some((item) => item.instanceId === middleId)).toBe(false);
			expect(images[1].runtimes.some((item) => item.instanceId === current.instanceId)).toBe(true);
			expect(current.incarnation).toBeGreaterThan(old.incarnation + 1);
			if (kind === "resume") {
				expect(current.mailboxId).toBe(old.mailboxId);
				expect(current.generation).toBe(old.generation + 1);
			} else expect(current.mailboxId).not.toBe(old.mailboxId);
			expect(fake.ownerOf("work")).toBe(old.mailboxId);
			expect(extensionErrors).toEqual([]);
			expect(faux.state.callCount).toBe(0);
			expect(agentStarts).toEqual([]);
			expect(streamInvocations).toEqual([]);
		},
	);

	it("resumes an already-ended detached binding with a fresh mailbox", async () => {
		const fake = new FakeRuntimeCoordinator();
		const { runtime, faux, agentStarts, streamInvocations } = await createRuntimeForTest(() => {});
		faux.setResponses([]);
		const initial = runtime.session;
		initial.runtimeLifecycle.participate();
		await initial.runtimeLifecycle.reconcile(fake.exchange);
		const old = initial.runtimeLifecycle.capture();
		const source = initial.sessionFile!;
		const binding = resolveConversationBinding(initial.sessionManager);
		fake.seedOwnedWork(old.mailboxId, "work");
		for (const kind of ["wait", "grant", "claim"] as const) fake.operate(old, kind, kind);
		expect(() => fake.seedEndedMailbox(binding)).toThrow("Cannot end attached mailbox");
		await runtime.newSession();
		await runtime.session.runtimeLifecycle.reconcile(fake.exchange);
		expect(fake.attachmentFor(old.mailboxId)).toBeUndefined();
		expect(fake.seedEndedMailbox(binding)).toBe(old.mailboxId);
		await runtime.switchSession(source);
		const facade = runtime.session.runtimeLifecycle;
		facade.participate();
		await facade.reconcile(fake.exchange);
		const current = facade.capture();
		expect(current.mailboxId).not.toBe(old.mailboxId);
		expect(fake.activeResourcesFor(current)).toEqual([]);
		expect([fake.resourceState("wait"), fake.resourceState("grant"), fake.resourceState("claim")]).toEqual([
			"interrupted",
			"revoked",
			"retired",
		]);
		expect(fake.ownerOf("work")).toBe(old.mailboxId);
		expect(faux.state.callCount).toBe(0);
		expect(agentStarts).toEqual([]);
		expect(streamInvocations).toEqual([]);
	});

	it("explicitly adopts an unchanged legacy saved conversation", async () => {
		const { runtime, faux, agentStarts, streamInvocations } = await createRuntimeForTest(() => {});
		faux.setResponses([]);
		const manager = runtime.session.sessionManager;
		manager.persistNow();
		manager.appendMessage(userMsg("legacy ordinary content"));
		const source = manager.getSessionFile()!;
		const before = readFileSync(source);
		const originalEntries = manager.getEntries();
		expect(JSON.parse(before.toString("utf8").split("\n")[0])).toMatchObject({ type: "session", version: 3 });
		await runtime.switchSession(source);
		const reopened = runtime.session.sessionManager;
		expect(reopened).not.toBe(manager);
		expect(reopened.getEntries()).toEqual(originalEntries);
		expect(JSON.stringify(reopened.buildSessionContext().messages)).toContain("legacy ordinary content");
		expect(readFileSync(source)).toEqual(before);
		const fake = new FakeRuntimeCoordinator();
		const facade = runtime.session.runtimeLifecycle;
		facade.participate();
		expect(await facade.reconcile(fake.exchange)).toBe("applied");
		expect(fake.attachmentFor(facade.capture().mailboxId)?.instanceId).toBe(facade.capture().instanceId);
		expect(readFileSync(source)).toEqual(before);
		expect(faux.state.callCount).toBe(0);
		expect(agentStarts).toEqual([]);
		expect(streamInvocations).toEqual([]);
	});

	it("auto-binding a nonparticipant does not save sessions", async () => {
		const { runtime, faux } = await createRuntimeForTest(() => {}, { autoBind: true });
		faux.setResponses([]);
		expect(existsSync(runtime.session.sessionFile!)).toBe(false);
		await runtime.newSession();
		expect(existsSync(runtime.session.sessionFile!)).toBe(false);
		expect(faux.state.callCount).toBe(0);
	});

	it("binds extension facades to their runner across reload, new and resume", async () => {
		const fake = new FakeRuntimeCoordinator();
		const apis: ExtensionAPI[] = [];
		const shutdownStates: string[] = [];
		const { runtime, faux, agentStarts, streamInvocations, extensionErrors } = await createRuntimeForTest(
			(pi) => {
				apis.push(pi);
				pi.on("session_start", async () => {
					const facade = pi.getRuntimeLifecycle();
					facade.participate();
					await facade.reconcile(fake.exchange);
				});
				pi.on("session_shutdown", async (event) => {
					const facade = pi.getRuntimeLifecycle();
					shutdownStates.push(facade.inspect().state);
					if (event.reason === "quit") await facade.reconcile(fake.exchange);
				});
			},
			{ autoBind: true },
		);
		faux.setResponses([]);
		const source = runtime.session.sessionFile!;
		const getter = apis[0].getRuntimeLifecycle;
		const first = getter();
		const firstFence = first.capture();
		const revoked: string[] = [];
		for (const kind of ["wait", "grant", "claim"] as const) {
			first.track(firstFence, { kind, id: kind, revoke: (reason) => revoked.push(reason) });
			fake.operate(firstFence, kind, kind);
		}
		const leaf = runtime.session.sessionManager.getLeafId();
		const bytes = readFileSync(source);
		await runtime.reload();
		const reloaded = apis[1].getRuntimeLifecycle();
		const reloadFence = reloaded.capture();
		expect(reloadFence.hostId).toBe(firstFence.hostId);
		expect(reloadFence.mailboxId).toBe(firstFence.mailboxId);
		expect(reloadFence.instanceId).not.toBe(firstFence.instanceId);
		expect(reloadFence.incarnation).toBeGreaterThan(firstFence.incarnation);
		expect(first.isCurrent(firstFence)).toBe(false);
		expect(() => getter()).toThrow(/stale/i);
		expect(() => first.capture()).toThrow();
		expect(revoked).toEqual(["runtime-detached", "runtime-detached", "runtime-detached"]);
		expect([fake.resourceState("wait"), fake.resourceState("grant"), fake.resourceState("claim")]).toEqual([
			"interrupted",
			"revoked",
			"retired",
		]);
		expect(() => fake.operate(firstFence, "stale", "status")).toThrow("stale runtime fence");
		expect(runtime.session.sessionManager.getLeafId()).toBe(leaf);
		expect(readFileSync(source)).toEqual(bytes);
		await runtime.newSession();
		expect(() => apis[1].getRuntimeLifecycle()).toThrow(/stale/i);
		expect(reloaded.isCurrent(reloadFence)).toBe(false);
		const fresh = apis[2].getRuntimeLifecycle().capture();
		expect(fresh.mailboxId).not.toBe(firstFence.mailboxId);
		await runtime.switchSession(source);
		expect(() => apis[2].getRuntimeLifecycle()).toThrow(/stale/i);
		const resumed = apis[3].getRuntimeLifecycle().capture();
		expect(resumed.mailboxId).toBe(firstFence.mailboxId);
		expect(resumed.incarnation).toBeGreaterThan(fresh.incarnation);
		expect(shutdownStates).toEqual(["retired", "retired", "retired"]);
		expect(extensionErrors).toEqual([]);
		expect(faux.state.callCount).toBe(0);
		expect(agentStarts).toEqual([]);
		expect(streamInvocations).toEqual([]);
		await runtime.dispose();
		expect(shutdownStates).toEqual(["retired", "retired", "retired", "retired"]);
		expect(fake.attachmentFor(resumed.mailboxId)).toBeUndefined();
	});

	it("invalidates the old extension runner even when reload shutdown throws", async () => {
		let api: ExtensionAPI | undefined;
		const { runtime, faux } = await createRuntimeForTest(
			(pi) => {
				api = pi;
			},
			{ autoBind: true },
		);
		faux.setResponses([]);
		const get = api!.getRuntimeLifecycle;
		const facade = get();
		const failure = new Error("shutdown failed");
		const spy = vi.spyOn(runtime.session, "shutdownRuntime").mockRejectedValue(failure);
		await expect(runtime.reload()).rejects.toBe(failure);
		spy.mockRestore();
		expect(() => get()).toThrow(/stale/i);
		expect(facade.inspect().state).toBe("retired");
		expect(faux.state.callCount).toBe(0);
	});

	it("retires a removed participating extension without implicit reattachment", async () => {
		let enabled = true;
		const fake = new FakeRuntimeCoordinator();
		let api: ExtensionAPI | undefined;
		const { runtime, faux, agentStarts, streamInvocations, extensionErrors } = await createRuntimeForTest(
			(pi) => {
				if (!enabled) return;
				api = pi;
				pi.on("session_start", async () => {
					pi.getRuntimeLifecycle().participate();
					await pi.getRuntimeLifecycle().reconcile(fake.exchange);
				});
			},
			{ autoBind: true },
		);
		faux.setResponses([]);
		const oldApi = api!;
		const old = oldApi.getRuntimeLifecycle();
		const fence = old.capture();
		const revoked: string[] = [];
		for (const kind of ["wait", "grant", "claim"] as const)
			old.track(fence, { kind, id: kind, revoke: (reason) => revoked.push(reason) });
		enabled = false;
		await runtime.reload();
		expect(() => oldApi.getRuntimeLifecycle()).toThrow(/stale/i);
		expect(old.isCurrent(fence)).toBe(false);
		expect(runtime.session.runtimeLifecycle.inspect().state).toBe("unregistered");
		expect(revoked).toEqual(["runtime-detached", "runtime-detached", "runtime-detached"]);
		expect(extensionErrors).toEqual([]);
		expect(faux.state.callCount).toBe(0);
		expect(agentStarts).toEqual([]);
		expect(streamInvocations).toEqual([]);
	});

	it("reload aborts a run started during beforeReload and persists its tool before shutdown", async () => {
		const started = Promise.withResolvers<void>();
		const aborted = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const shutdown = Promise.withResolvers<void>();
		const order: string[] = [];
		const { runtime, faux, agentStarts, streamInvocations, extensionErrors } = await createRuntimeForTest((pi) => {
			pi.registerTool({
				name: "reload_block",
				label: "block",
				description: "block",
				parameters: Type.Object({}),
				execute: async (_id, _params, signal) => {
					started.resolve();
					await new Promise<void>((resolve) =>
						signal?.addEventListener("abort", () => {
							aborted.resolve();
							resolve();
						}),
					);
					await release.promise;
					order.push("tool result");
					return { content: [{ type: "text", text: "reload aborted tool" }], details: {} };
				},
			});
			pi.on("session_shutdown", (event) => {
				if (event.reason === "reload") {
					order.push("shutdown");
					shutdown.resolve();
				}
			});
		});
		faux.setResponses([fauxAssistantMessage(fauxToolCall("reload_block", {}), { stopReason: "toolUse" })]);
		const scope = runtime.session.runtimeLifecycle;
		scope.participate();
		await scope.reconcile(new FakeRuntimeCoordinator().exchange);
		const fence = scope.capture();
		const revoked: string[] = [];
		for (const kind of ["wait", "grant", "claim"] as const)
			scope.track(fence, { kind, id: kind, revoke: (reason) => revoked.push(reason) });
		let prompt: Promise<void> | undefined;
		const reload = runtime.session.reload({
			beforeReload: async () => {
				prompt = runtime.session.prompt("block");
				await started.promise;
			},
		});
		await aborted.promise;
		expect(scope.isCurrent(fence)).toBe(false);
		expect(revoked).toEqual(["runtime-detached", "runtime-detached", "runtime-detached"]);
		expect(order).toEqual([]);
		release.resolve();
		await prompt;
		await reload;
		await shutdown.promise;
		expect(order).toEqual(["tool result", "shutdown"]);
		expect(JSON.stringify(SessionManager.open(runtime.session.sessionFile!).getEntries())).toContain(
			"reload aborted tool",
		);
		expect(faux.state.callCount).toBe(1);
		expect(agentStarts).toHaveLength(1);
		expect(streamInvocations).toHaveLength(1);
		expect(extensionErrors).toEqual([]);
	});

	it("new and resume rotate instances but resume preserves the original owner", async () => {
		const { runtime, faux, agentStarts, streamInvocations } = await createRuntimeForTest(() => {});
		faux.setResponses([]);
		const fake = new FakeRuntimeCoordinator();
		const first = runtime.session;
		first.sessionManager.persistNow();
		first.runtimeLifecycle.participate();
		await first.runtimeLifecycle.reconcile(fake.exchange);
		const old = first.runtimeLifecycle.capture();
		const firstFile = first.sessionFile!;
		fake.seedOwnedWork(old.mailboxId, "owned-work");
		await runtime.newSession();
		runtime.session.runtimeLifecycle.participate();
		await runtime.session.runtimeLifecycle.reconcile(fake.exchange);
		const fresh = runtime.session.runtimeLifecycle.capture();
		expect(fresh.mailboxId).not.toBe(old.mailboxId);
		expect(fresh.hostId).toBe(old.hostId);
		expect(fresh.incarnation).toBeGreaterThan(old.incarnation);
		await runtime.switchSession(firstFile);
		runtime.session.runtimeLifecycle.participate();
		await runtime.session.runtimeLifecycle.reconcile(fake.exchange);
		const resumed = runtime.session.runtimeLifecycle.capture();
		expect(resumed.mailboxId).toBe(old.mailboxId);
		expect(resumed.instanceId).not.toBe(old.instanceId);
		expect(fake.ownerOf("owned-work")).toBe(old.mailboxId);
		expect(first.runtimeLifecycle.isCurrent(old)).toBe(false);
		expect(faux.state.callCount).toBe(0);
		expect(agentStarts).toEqual([]);
		expect(streamInvocations).toEqual([]);
	});

	it("retires and drains outgoing scope while shutdown is paused", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { runtime, faux } = await createRuntimeForTest((pi) => {
			pi.on("session_shutdown", async (event) => {
				if (event.reason === "new") {
					entered.resolve();
					await release.promise;
				}
			});
		});
		faux.setResponses([]);
		const scope = runtime.session.runtimeLifecycle;
		scope.participate();
		await scope.reconcile(new FakeRuntimeCoordinator().exchange);
		const fence = scope.capture();
		const revoked: string[] = [];
		for (const kind of ["wait", "grant", "claim"] as const)
			scope.track(fence, { kind, id: kind, revoke: () => revoked.push(kind) });
		const replacement = runtime.newSession();
		await entered.promise;
		expect(scope.inspect().state).toBe("retired");
		expect(scope.isCurrent(fence)).toBe(false);
		expect(revoked).toEqual(["wait", "grant", "claim"]);
		release.resolve();
		await replacement;
	});

	it("retires before a blocked tool finishes aborting", async () => {
		const started = Promise.withResolvers<void>();
		const aborted = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { runtime, faux } = await createRuntimeForTest((pi) => {
			pi.registerTool({
				name: "block",
				label: "block",
				description: "block",
				parameters: Type.Object({}),
				execute: async (_id, _params, signal) => {
					started.resolve();
					await new Promise<void>((resolve) =>
						signal?.addEventListener("abort", () => {
							aborted.resolve();
							resolve();
						}),
					);
					await release.promise;
					return { content: [{ type: "text", text: "aborted" }], details: {} };
				},
			});
		});
		faux.setResponses([fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" })]);
		const scope = runtime.session.runtimeLifecycle;
		scope.participate();
		await scope.reconcile(new FakeRuntimeCoordinator().exchange);
		const fence = scope.capture();
		const outgoing = runtime.session;
		const revoked: string[] = [];
		for (const kind of ["wait", "grant", "claim"] as const)
			scope.track(fence, { kind, id: kind, revoke: () => revoked.push(kind) });
		const prompt = outgoing.prompt("block");
		await started.promise;
		const replacement = runtime.newSession();
		await aborted.promise;
		expect(scope.inspect().state).toBe("retired");
		expect(scope.isCurrent(fence)).toBe(false);
		expect(revoked).toEqual(["wait", "grant", "claim"]);
		release.resolve();
		await prompt;
		await replacement;
		expect(JSON.stringify(SessionManager.open(outgoing.sessionFile!).getEntries())).toContain("aborted");
	});

	it("keeps the old fence and resources after veto and invalid target", async () => {
		let veto = true;
		const { runtime, faux, tempDir } = await createRuntimeForTest((pi) => {
			pi.on("session_before_switch", () => (veto ? { cancel: true } : undefined));
			pi.on("session_before_fork", () => (veto ? { cancel: true } : undefined));
		});
		faux.setResponses([]);
		const scope = runtime.session.runtimeLifecycle;
		scope.participate();
		await scope.reconcile(new FakeRuntimeCoordinator().exchange);
		const fence = scope.capture();
		const revoked: string[] = [];
		for (const kind of ["wait", "grant", "claim"] as const)
			scope.track(fence, { kind, id: kind, revoke: () => revoked.push(kind) });
		expect(await runtime.newSession()).toEqual({ cancelled: true });
		expect(await runtime.fork("missing")).toEqual({ cancelled: true });
		veto = false;
		await expect(runtime.fork("missing")).rejects.toThrow("Invalid entry ID");
		await expect(runtime.switchSession(join(tempDir, "missing.jsonl"))).rejects.toThrow();
		const badCwd = SessionManager.create(join(tempDir, "missing-cwd"), join(tempDir, "bad-sessions"));
		badCwd.persistNow();
		await expect(runtime.switchSession(badCwd.getSessionFile()!)).rejects.toThrow("working directory does not exist");
		expect(scope.isCurrent(fence)).toBe(true);
		expect(revoked).toEqual([]);
	});

	it("rejects overlapping replacements and lets disposal win a gate", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { runtime, faux, sessions } = await createRuntimeForTest((pi) => {
			pi.on("session_before_switch", async () => {
				entered.resolve();
				await release.promise;
			});
		});
		faux.setResponses([]);
		const replacing = runtime.newSession();
		const rejected = expect(replacing).rejects.toBeInstanceOf(RuntimeDisposedError);
		await entered.promise;
		expect(runtime.isReplacementInProgress).toBe(true);
		await expect(runtime.newSession()).rejects.toBeInstanceOf(RuntimeReplacementInProgressError);
		const cleanup = runtime.dispose();
		release.resolve();
		await cleanup;
		await rejected;
		expect(sessions).toHaveLength(1);
		await expect(runtime.session.prompt("late")).rejects.toBeInstanceOf(RuntimeDisposedError);
	});

	it("shares shutdown when disposal preempts a replacement in teardown", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const reasons: string[] = [];
		const { runtime, faux, sessions } = await createRuntimeForTest((pi) => {
			pi.on("session_shutdown", async (event) => {
				reasons.push(event.reason);
				entered.resolve();
				await release.promise;
			});
		});
		faux.setResponses([]);
		const replacement = runtime.newSession();
		const rejected = expect(replacement).rejects.toBeInstanceOf(RuntimeDisposedError);
		await entered.promise;
		const cleanup = runtime.dispose();
		expect(runtime.dispose()).toBe(cleanup);
		await expect(runtime.session.prompt("late")).rejects.toBeInstanceOf(RuntimeDisposedError);
		release.resolve();
		await cleanup;
		await rejected;
		expect(reasons).toEqual(["new"]);
		expect(sessions).toHaveLength(1);
	});

	it("reports busy for every overlap while target creation is paused", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let created = 0;
		const { runtime, faux, sessions } = await createRuntimeForTest(() => {}, {
			afterCreate: async () => {
				if (++created === 2) {
					entered.resolve();
					await release.promise;
				}
			},
		});
		faux.setResponses([]);
		const replacing = runtime.newSession();
		await entered.promise;
		try {
			for (const operation of [
				() => runtime.newSession(),
				() => runtime.switchSession("missing"),
				() => runtime.fork("missing"),
				() => runtime.importFromJsonl("missing"),
				() => runtime.reload(),
			]) {
				await expect(operation()).rejects.toBeInstanceOf(RuntimeReplacementInProgressError);
			}
			expect(sessions).toHaveLength(2);
		} finally {
			release.resolve();
			await replacing;
		}
	});

	it("reports refusals through the handler as cancelled results, except reload", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let created = 0;
		const { runtime, faux, sessions } = await createRuntimeForTest(() => {}, {
			afterCreate: async () => {
				if (++created === 2) {
					entered.resolve();
					await release.promise;
				}
			},
		});
		faux.setResponses([]);
		const refused = vi.fn();
		runtime.onReplacementRefused = refused;
		const replacing = runtime.newSession();
		await entered.promise;
		try {
			for (const operation of [
				() => runtime.newSession(),
				() => runtime.switchSession("missing"),
				() => runtime.fork("missing"),
				() => runtime.importFromJsonl("missing"),
			]) {
				expect(await operation()).toEqual({ cancelled: true });
			}
			await expect(runtime.reload()).rejects.toBeInstanceOf(RuntimeReplacementInProgressError);
			expect(refused).toHaveBeenCalledTimes(4);
			expect(sessions).toHaveLength(2);
		} finally {
			release.resolve();
			await replacing;
		}
		const reload = runtime.session.reload({ beforeReload: () => entered.promise });
		expect(await runtime.newSession()).toEqual({ cancelled: true });
		await reload;
		expect(refused).toHaveBeenCalledTimes(5);
	});

	it("reserves the applied candidate against direct reload during rebind", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { runtime, faux } = await createRuntimeForTest(() => {});
		faux.setResponses([]);
		runtime.setRebindSession(async () => {
			entered.resolve();
			await release.promise;
		});
		const replacing = runtime.newSession();
		await entered.promise;
		try {
			expect(runtime.session.isReplacementInProgress).toBe(true);
			await expect(
				runtime.session.reload({
					beforeReload: () => {
						throw new Error("unexpected reload");
					},
				}),
			).rejects.toBeInstanceOf(RuntimeReplacementInProgressError);
			await expect(runtime.newSession()).rejects.toBeInstanceOf(RuntimeReplacementInProgressError);
		} finally {
			release.resolve();
			await replacing;
		}
	});

	it("disposes a late candidate without applying or starting it", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let created = 0;
		const { runtime, faux, sessions, agentStarts, streamInvocations } = await createRuntimeForTest(() => {}, {
			afterCreate: async () => {
				if (++created === 2) {
					entered.resolve();
					await release.promise;
				}
			},
		});
		faux.setResponses([]);
		const outgoing = runtime.session;
		let rebinds = 0;
		runtime.setRebindSession(async () => {
			rebinds++;
		});
		const replacement = runtime.newSession();
		const rejected = expect(replacement).rejects.toBeInstanceOf(RuntimeDisposedError);
		await entered.promise;
		await runtime.dispose();
		release.resolve();
		await rejected;
		expect(runtime.session).toBe(outgoing);
		expect(sessions).toHaveLength(2);
		expect(sessions[1].isDisposed).toBe(true);
		expect(rebinds).toBe(0);
		expect(agentStarts).toEqual([]);
		expect(streamInvocations).toEqual([]);
	});

	it("leaves the outgoing session unavailable when factory creation fails", async () => {
		let creates = 0;
		const { runtime, faux, sessions, agentStarts, streamInvocations } = await createRuntimeForTest(() => {}, {
			beforeCreate: async () => {
				if (++creates === 2) throw new Error("factory failed");
			},
		});
		faux.setResponses([]);
		const outgoing = runtime.session;
		outgoing.runtimeLifecycle.participate();
		await outgoing.runtimeLifecycle.reconcile(new FakeRuntimeCoordinator().exchange);
		const fence = outgoing.runtimeLifecycle.capture();
		await expect(runtime.newSession()).rejects.toThrow("factory failed");
		expect(outgoing.runtimeLifecycle.isCurrent(fence)).toBe(false);
		expect(outgoing.isDisposed).toBe(true);
		expect(sessions).toHaveLength(1);
		await expect(runtime.session.prompt("late")).rejects.toBeInstanceOf(RuntimeDisposedError);
		expect(agentStarts).toEqual([]);
		expect(streamInvocations).toEqual([]);
	});

	it("disposes the applied candidate when rebind fails", async () => {
		const { runtime, faux, sessions, agentStarts, streamInvocations } = await createRuntimeForTest(() => {});
		faux.setResponses([]);
		const outgoing = runtime.session;
		runtime.setRebindSession(async (candidate) => {
			candidate.runtimeLifecycle.participate();
			throw new Error("rebind failed");
		});
		await expect(runtime.newSession()).rejects.toThrow("rebind failed");
		expect(outgoing.isDisposed).toBe(true);
		expect(sessions[1].isDisposed).toBe(true);
		expect(sessions[1].runtimeLifecycle.inspect().state).toBe("retired");
		await expect(runtime.session.prompt("late")).rejects.toBeInstanceOf(RuntimeDisposedError);
		expect(agentStarts).toEqual([]);
		expect(streamInvocations).toEqual([]);
	});

	it("disposes a candidate when setup fails", async () => {
		const { runtime, faux, sessions } = await createRuntimeForTest(() => {});
		faux.setResponses([]);
		const outgoing = runtime.session;
		await expect(
			runtime.newSession({
				setup: async () => {
					sessions[1].runtimeLifecycle.participate();
					throw new Error("setup failed");
				},
			}),
		).rejects.toThrow("setup failed");
		expect(outgoing.isDisposed).toBe(true);
		expect(sessions).toHaveLength(2);
		expect(sessions[1].isDisposed).toBe(true);
		expect(sessions[1].runtimeLifecycle.inspect().state).toBe("retired");
		await expect(runtime.session.prompt("late")).rejects.toBeInstanceOf(RuntimeDisposedError);
	});

	it.each(["abort", "shutdown", "invalidate"] as const)("cleans up when %s throws during teardown", async (phase) => {
		const failure = new Error(`${phase} failed`);
		const { runtime, faux, sessions } = await createRuntimeForTest(() => {}, { expectedDisposeError: failure });
		faux.setResponses([]);
		const outgoing = runtime.session;
		outgoing.runtimeLifecycle.participate();
		await outgoing.runtimeLifecycle.reconcile(new FakeRuntimeCoordinator().exchange);
		const fence = outgoing.runtimeLifecycle.capture();
		const spy =
			phase === "abort"
				? vi.spyOn(outgoing, "abort").mockRejectedValue(failure)
				: phase === "shutdown"
					? vi.spyOn(outgoing, "shutdownRuntime").mockRejectedValue(failure)
					: undefined;
		if (phase === "invalidate")
			runtime.setBeforeSessionInvalidate(() => {
				throw failure;
			});
		await expect(runtime.newSession()).rejects.toBe(failure);
		spy?.mockRestore();
		runtime.setBeforeSessionInvalidate(undefined);
		expect(outgoing.isDisposed).toBe(true);
		expect(outgoing.runtimeLifecycle.isCurrent(fence)).toBe(false);
		expect(sessions).toHaveLength(1);
		await expect(outgoing.prompt("late")).rejects.toBeInstanceOf(RuntimeDisposedError);
	});

	it.each(["setup", "rebind"] as const)("disposal wins while candidate %s is paused", async (phase) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const starts: string[] = [];
		const { runtime, faux, sessions, agentStarts, streamInvocations } = await createRuntimeForTest((pi) => {
			pi.on("session_start", (event) => {
				starts.push(event.reason);
			});
		});
		faux.setResponses([]);
		let rebinds = 0;
		runtime.setRebindSession(async (candidate) => {
			rebinds++;
			if (phase === "rebind") {
				entered.resolve();
				await release.promise;
				await candidate.bindExtensions({});
			}
		});
		const outgoing = runtime.session;
		const replacement = runtime.newSession({
			setup: async () => {
				if (phase === "setup") {
					entered.resolve();
					await release.promise;
				}
			},
		});
		const rejected = expect(replacement).rejects.toBeInstanceOf(RuntimeDisposedError);
		await entered.promise;
		const candidate = sessions[1];
		expect(candidate.isReplacementInProgress).toBe(true);
		await expect(candidate.reload()).rejects.toBeInstanceOf(RuntimeReplacementInProgressError);
		await expect(runtime.newSession()).rejects.toBeInstanceOf(RuntimeReplacementInProgressError);
		await runtime.dispose();
		await expect(candidate.prompt("during disposal")).rejects.toBeInstanceOf(RuntimeDisposedError);
		await expect(runtime.newSession()).rejects.toBeInstanceOf(RuntimeDisposedError);
		await expect(runtime.reload()).rejects.toBeInstanceOf(RuntimeDisposedError);
		release.resolve();
		await rejected;
		expect(candidate.isDisposed).toBe(true);
		expect(runtime.session).toBe(phase === "setup" ? outgoing : candidate);
		expect(rebinds).toBe(phase === "setup" ? 0 : 1);
		expect(starts).toEqual(["startup"]);
		expect(agentStarts).toEqual([]);
		expect(streamInvocations).toEqual([]);
		await expect(candidate.prompt("late")).rejects.toBeInstanceOf(RuntimeDisposedError);
	});

	it("direct session disposal preempts paused reload", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { runtime, faux, agentStarts, streamInvocations } = await createRuntimeForTest(() => {});
		faux.setResponses([]);
		const session = runtime.session;
		const reload = session.reload({
			beforeReload: async () => {
				entered.resolve();
				await release.promise;
			},
		});
		const rejected = expect(reload).rejects.toBeInstanceOf(RuntimeDisposedError);
		await entered.promise;
		session.dispose();
		release.resolve();
		await rejected;
		await expect(session.prompt("late")).rejects.toBeInstanceOf(RuntimeDisposedError);
		expect(agentStarts).toEqual([]);
		expect(streamInvocations).toEqual([]);
	});

	it("holds both reload guards and lets disposal preempt beforeReload", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { runtime, faux } = await createRuntimeForTest(() => {});
		faux.setResponses([]);
		const session = runtime.session;
		const scope = session.runtimeLifecycle;
		scope.participate();
		await scope.reconcile(new FakeRuntimeCoordinator().exchange);
		const fence = scope.capture();
		const reload = runtime.reload({
			beforeReload: async () => {
				entered.resolve();
				await release.promise;
			},
		});
		const rejected = expect(reload).rejects.toBeInstanceOf(RuntimeDisposedError);
		await entered.promise;
		expect(scope.isCurrent(fence)).toBe(false);
		expect(runtime.isReplacementInProgress).toBe(true);
		expect(session.isReplacementInProgress).toBe(true);
		await expect(runtime.newSession()).rejects.toBeInstanceOf(RuntimeReplacementInProgressError);
		await expect(session.reload()).rejects.toBeInstanceOf(RuntimeReplacementInProgressError);
		const cleanup = runtime.dispose();
		release.resolve();
		await cleanup;
		await rejected;
	});

	it("releases replacement guards while withSession awaits a real turn", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const { runtime, faux } = await createRuntimeForTest((pi) => {
			pi.registerTool({
				name: "wait",
				label: "wait",
				description: "wait",
				parameters: Type.Object({}),
				execute: async () => {
					entered.resolve();
					await release.promise;
					return { content: [{ type: "text", text: "done" }], details: {} };
				},
			});
		});
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		const replacement = runtime.newSession({
			withSession: async (ctx) => {
				await ctx.sendUserMessage("run");
			},
		});
		await entered.promise;
		expect(runtime.isReplacementInProgress).toBe(false);
		expect(runtime.session.isReplacementInProgress).toBe(false);
		release.resolve();
		await replacement;
		expect(faux.state.callCount).toBe(2);
	});

	it("releases replacement guards before callback and preserves session on callback failure", async () => {
		const { runtime, faux } = await createRuntimeForTest(() => {});
		faux.setResponses([]);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const replacement = runtime.newSession({
			withSession: async () => {
				entered.resolve();
				await release.promise;
				throw new Error("callback");
			},
		});
		const rejected = expect(replacement).rejects.toThrow("callback");
		await entered.promise;
		expect(runtime.isReplacementInProgress).toBe(false);
		expect(runtime.session.isReplacementInProgress).toBe(false);
		const current = runtime.session;
		release.resolve();
		await rejected;
		expect(current.isDisposed).toBe(false);
		faux.setResponses([fauxAssistantMessage("usable")]);
		await current.prompt("still usable");
		expect(faux.state.callCount).toBe(1);
		await runtime.newSession();
	});

	it("forks before and at a selected user without copying pending mail, then preserves inherited origin", async () => {
		const { runtime, faux, agentStarts, streamInvocations } = await createRuntimeForTest(() => {});
		faux.setResponses([]);
		expect(faux.state.callCount).toBe(0);
		const manager = runtime.session.sessionManager;
		manager.persistNow();
		const root = manager.appendMessage(userMsg("ordinary root"));
		const pending = manager.appendEntryOnce(canonical("pending"), root).entryId;
		manager.branch(pending);
		const anchor = manager.appendMessage(userMsg("after pending"));
		const admitted = selectSyntheticAdmission(manager, admission(canonical("admitted", "other"), anchor));
		const selectedUser = manager.appendMessage(userMsg("ordinary selected"));
		const leaf = manager.appendMessage(userMsg("ordinary leaf"));
		const source = manager.getSessionFile()!;
		const sourceId = manager.getSessionId();
		const originalBytes = readFileSync(source);
		const fake = new FakeRuntimeCoordinator();
		const sourceScope = runtime.session.runtimeLifecycle;
		sourceScope.participate();
		await sourceScope.reconcile(fake.exchange);
		const sourceFence = sourceScope.capture();
		fake.seedOwnedWork(sourceFence.mailboxId, "fork-owned");
		const revoked: string[] = [];
		for (const kind of ["wait", "grant", "claim"] as const)
			sourceScope.track(sourceFence, { kind, id: kind, revoke: () => revoked.push(kind) });
		const starts: string[] = [];
		runtime.session.subscribe((event) => {
			if (event.type === "agent_start") starts.push(event.type);
		});
		const before = await runtime.fork(selectedUser, { position: "before" });
		expect(revoked).toEqual(["wait", "grant", "claim"]);
		expect(sourceScope.isCurrent(sourceFence)).toBe(false);
		runtime.session.runtimeLifecycle.participate();
		await runtime.session.runtimeLifecycle.reconcile(fake.exchange);
		const beforeFence = runtime.session.runtimeLifecycle.capture();
		expect(beforeFence.mailboxId).not.toBe(sourceFence.mailboxId);
		expect(beforeFence.instanceId).not.toBe(sourceFence.instanceId);
		expect(beforeFence.hostId).toBe(sourceFence.hostId);
		expect(beforeFence.incarnation).toBeGreaterThan(sourceFence.incarnation);
		expect(fake.ownerOf("fork-owned")).toBe(sourceFence.mailboxId);
		expect(before.selectedText).toBe("ordinary selected");
		let destination = SessionManager.open(runtime.session.sessionFile!);
		expect(readFileSync(destination.getSessionFile()!, "utf8")).not.toContain(PENDING_BODY);
		expect(JSON.stringify(destination.buildSessionContext().messages)).toContain(ADMITTED_BODY);
		let inherited = destination
			.getEntries()
			.map(readExternalEntry)
			.find((record) => record?.kind === "inherited");
		expect(inherited).toMatchObject({
			origin: { sessionId: sourceId, entryId: admitted },
			copiedFrom: { sessionId: sourceId, entryId: admitted },
		});
		await runtime.switchSession(source);
		runtime.session.runtimeLifecycle.participate();
		await runtime.session.runtimeLifecycle.reconcile(fake.exchange);
		const resumedScope = runtime.session.runtimeLifecycle;
		const resumedFence = resumedScope.capture();
		const resumedRevoked: string[] = [];
		for (const kind of ["wait", "grant", "claim"] as const)
			resumedScope.track(resumedFence, { kind, id: kind, revoke: () => resumedRevoked.push(kind) });
		await runtime.fork(leaf, { position: "at" });
		expect(resumedScope.isCurrent(resumedFence)).toBe(false);
		expect(resumedRevoked).toEqual(["wait", "grant", "claim"]);
		runtime.session.runtimeLifecycle.participate();
		await runtime.session.runtimeLifecycle.reconcile(fake.exchange);
		const atFence = runtime.session.runtimeLifecycle.capture();
		expect(atFence.mailboxId).not.toBe(resumedFence.mailboxId);
		expect(atFence.instanceId).not.toBe(resumedFence.instanceId);
		expect(atFence.hostId).toBe(resumedFence.hostId);
		expect(atFence.incarnation).toBeGreaterThan(resumedFence.incarnation);
		expect(fake.ownerOf("fork-owned")).toBe(sourceFence.mailboxId);
		destination = SessionManager.open(runtime.session.sessionFile!);
		expect(destination.getLeafId()).toBe(leaf);
		expect(readFileSync(destination.getSessionFile()!, "utf8")).not.toContain(PENDING_BODY);
		const secondSourceId = destination.getSessionId();
		const historyEntry = destination.getEntries().find((entry) => readExternalEntry(entry)?.kind === "inherited")!;
		await runtime.fork(leaf, { position: "at" });
		runtime.session.runtimeLifecycle.participate();
		await runtime.session.runtimeLifecycle.reconcile(fake.exchange);
		const nextFence = runtime.session.runtimeLifecycle.capture();
		expect(nextFence.mailboxId).not.toBe(atFence.mailboxId);
		expect(nextFence.instanceId).not.toBe(atFence.instanceId);
		expect(nextFence.hostId).toBe(atFence.hostId);
		expect(nextFence.incarnation).toBeGreaterThan(atFence.incarnation);
		expect(fake.ownerOf("fork-owned")).toBe(sourceFence.mailboxId);
		destination = SessionManager.open(runtime.session.sessionFile!);
		expect(readFileSync(destination.getSessionFile()!, "utf8")).not.toContain(PENDING_BODY);
		inherited = destination
			.getEntries()
			.map(readExternalEntry)
			.find((record) => record?.kind === "inherited");
		expect(inherited).toMatchObject({
			origin: { sessionId: sourceId, entryId: admitted },
			copiedFrom: { sessionId: secondSourceId, entryId: historyEntry.id },
		});
		expect(readFileSync(source)).toEqual(originalBytes);
		expect(faux.state.callCount).toBe(0);
		expect(starts).toEqual([]);
		expect(agentStarts).toEqual([]);
		expect(streamInvocations).toEqual([]);
	});

	it("forks a root user to an empty persisted session", async () => {
		const { runtime, faux, agentStarts, streamInvocations } = await createRuntimeForTest(() => {});
		faux.setResponses([]);
		const manager = runtime.session.sessionManager;
		manager.persistNow();
		manager.resetLeaf();
		const root = manager.appendMessage(userMsg("root prompt"));
		const source = manager.getSessionFile()!;
		const bytes = readFileSync(source);
		const fake = new FakeRuntimeCoordinator();
		const scope = runtime.session.runtimeLifecycle;
		scope.participate();
		await scope.reconcile(fake.exchange);
		const fence = scope.capture();
		fake.seedOwnedWork(fence.mailboxId, "root-owned");
		const revoked: string[] = [];
		for (const kind of ["wait", "grant", "claim"] as const)
			scope.track(fence, { kind, id: kind, revoke: () => revoked.push(kind) });
		const result = await runtime.fork(root, { position: "before" });
		runtime.session.runtimeLifecycle.participate();
		await runtime.session.runtimeLifecycle.reconcile(fake.exchange);
		const fresh = runtime.session.runtimeLifecycle.capture();
		expect(fresh.mailboxId).not.toBe(fence.mailboxId);
		expect(fresh.instanceId).not.toBe(fence.instanceId);
		expect(fresh.hostId).toBe(fence.hostId);
		expect(fresh.incarnation).toBeGreaterThan(fence.incarnation);
		expect(fake.ownerOf("root-owned")).toBe(fence.mailboxId);
		expect(scope.isCurrent(fence)).toBe(false);
		expect(revoked).toEqual(["wait", "grant", "claim"]);
		expect(readFileSync(source)).toEqual(bytes);
		expect(result.selectedText).toBe("root prompt");
		const path = runtime.session.sessionManager.persistNow();
		const reopened = SessionManager.open(path);
		expect(reopened.getEntries().some((entry) => readExternalEntry(entry))).toBe(false);
		expect(reopened.buildSessionContext().messages).toEqual([]);
		expect(faux.state.callCount).toBe(0);
		expect(agentStarts).toEqual([]);
		expect(streamInvocations).toEqual([]);
	});

	it("settles the active response before session replacement without another model request", async () => {
		let toolStarted!: () => void;
		const toolStartedPromise = new Promise<void>((resolve) => {
			toolStarted = resolve;
		});
		const { runtime, faux, agentStarts, streamInvocations } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.registerTool({
				name: "block",
				label: "Block",
				description: "Blocks until aborted",
				parameters: Type.Object({}),
				execute: (_toolCallId, _params, signal) =>
					new Promise<AgentToolResult<unknown>>((resolve) => {
						toolStarted();
						signal?.addEventListener("abort", () =>
							resolve({ content: [{ type: "text", text: "tool aborted" }], details: {} }),
						);
					}),
			});
		});

		await runtime.session.prompt("hello");
		const firstSessionFile = runtime.session.sessionFile!;
		await runtime.newSession();
		await runtime.session.bindExtensions({});

		faux.setResponses([fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" })]);
		const outgoingSession = runtime.session;
		const suppressed: Array<{ reason: string; errorMessage: string }> = [];
		outgoingSession.subscribe((event) => {
			if (event.type === "request_suppressed") suppressed.push(event);
		});
		const callsBefore = faux.state.callCount;
		const streamsBefore = streamInvocations.length;
		const startsBefore = agentStarts.length;
		const promptPromise = outgoingSession.prompt("start blocking tool");
		await toolStartedPromise;

		const switchResult = await runtime.switchSession(firstSessionFile);
		await promptPromise;

		expect(switchResult.cancelled).toBe(false);
		expect(runtime.session.sessionFile).toBe(firstSessionFile);
		// The outgoing session settled before replacement: the interrupted tool
		// call has a persisted tool result instead of dangling forever.
		const outgoingEntries = SessionManager.open(outgoingSession.sessionFile!)
			.getEntries()
			.filter((entry) => entry.type === "message");
		expect(outgoingEntries.map((entry) => entry.message.role)).toEqual(["system", "user", "assistant", "toolResult"]);
		const assistant = outgoingEntries[2].message;
		const result = outgoingEntries[3].message;
		if (assistant.role !== "assistant" || result.role !== "toolResult")
			throw new Error("missing completed tool batch");
		const calls = assistant.content.filter((part) => part.type === "toolCall");
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe("block");
		expect(result.toolCallId).toBe(calls[0].id);
		expect(result.content).toEqual([{ type: "text", text: "tool aborted" }]);
		expect(faux.state.callCount - callsBefore).toBe(1);
		expect(streamInvocations.length - streamsBefore).toBe(1);
		expect(agentStarts.length - startsBefore).toBe(1);
		expect(suppressed).toMatchObject([{ reason: "cancelled" }]);
	});
});
