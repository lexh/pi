import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestAdmissionOwner } from "../../src/core/request-admission.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createAdmissionHarness } from "../helpers/request-admission.ts";

describe("bound request cancellation", () => {
	const fixtures: Array<Awaited<ReturnType<typeof createAdmissionHarness>>> = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	it.each(["before-snapshot", "delivered", "workspace", "transform", "conversion", "workspace-reject"] as const)(
		"stops without an admission when aborted at %s",
		async (boundary) => {
			const fixture = await createAdmissionHarness();
			fixtures.push(fixture);
			const { harness, coordinator, manager } = fixture;
			harness.session.refreshContext();
			const event = coordinator.seedEvent(boundary, `PRIVATE_${boundary}`);
			coordinator.seedMatchingConsumption(event, "claim");
			coordinator.omitOrdinaryCandidate(event);
			harness.session.requestAdmission.bind(coordinator);
			harness.session.requestAdmission.stageCompletedWait(event, fixture.fence);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			let held = false;
			const wait = async () => {
				if (held) return;
				held = true;
				entered.resolve();
				await release.promise;
				if (boundary === "workspace-reject") throw new Error("held rejection");
			};
			const snapshot = vi.spyOn(coordinator, "snapshot");
			const originalDelivered = coordinator.delivered.bind(coordinator);
			const delivered = vi.spyOn(coordinator, "delivered");
			const admit = vi.spyOn(coordinator, "admit");
			if (boundary === "before-snapshot") {
				const original = harness.session.agent.prepareRequest;
				if (!original) throw new Error("missing preparation");
				harness.session.agent.prepareRequest = async (...args) => {
					await wait();
					return (await original(...args)) || undefined;
				};
			} else if (boundary === "delivered") {
				delivered.mockImplementation(async (...args) => {
					await originalDelivered(...args);
					await wait();
				});
			} else if (boundary === "workspace" || boundary === "workspace-reject") {
				const original = coordinator.workspace.bind(coordinator);
				vi.spyOn(coordinator, "workspace").mockImplementation(async (...args) => {
					await wait();
					return original(...args);
				});
			} else if (boundary === "transform") {
				const original = harness.session.agent.transformContext;
				harness.session.agent.transformContext = async (messages, signal) => {
					await wait();
					return (await original?.(messages, signal)) ?? messages;
				};
			} else {
				const original = harness.session.agent.convertToLlm;
				harness.session.agent.convertToLlm = async (...args) => {
					await wait();
					return original(...args);
				};
			}
			const stream = vi.spyOn(harness.session.agent, "streamFunction");
			const initialAssistants = manager
				.getEntries()
				.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length;
			const running = harness.session.prompt("ordinary");
			await entered.promise;
			const root = manager.getLeafId();
			await harness.session.followUp("queued followup");
			const aborting = harness.session.abort();
			const repeated = harness.session.abort();
			const inspection = harness.session.runtimeLifecycle.inspect();
			release.resolve();
			await Promise.all([running, aborting, repeated]);
			expect(inspection).toMatchObject({ epoch: fixture.fence.epoch + 1 });
			expect(snapshot).toHaveBeenCalledTimes(boundary === "before-snapshot" ? 0 : 1);
			expect(delivered).toHaveBeenCalledTimes(["before-snapshot"].includes(boundary) ? 0 : 1);
			expect(admit).not.toHaveBeenCalled();
			expect(stream).not.toHaveBeenCalled();
			expect(harness.faux.state.callCount).toBe(0);
			expect(coordinator.inspectEvent(event)?.state).toBe("pending");
			expect(coordinator.inspectConsumption(event)).toBe("claim");
			expect(
				manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "assistant"),
			).toHaveLength(initialAssistants);
			expect(manager.getLeafId()).toBe(root);
			expect(harness.session.messages).toEqual(manager.buildSessionProjection().messages);
			expect(harness.session.pendingMessageCount).toBe(1);
			const file = manager.getSessionFile();
			if (!file) throw new Error("missing session file");
			expect(SessionManager.open(file).getLeafId()).toBe(root);
			await harness.session.runtimeLifecycle.reconcile(fixture.runtimeCoordinator.exchange);
			const nextIndex = snapshot.mock.calls.length;
			harness.setResponses([fauxAssistantMessage("next")]);
			await harness.session.prompt("explicit next");
			expect(snapshot.mock.calls[nextIndex]?.[0].references).toEqual([
				{ recipientIdentity: event.recipientIdentity, eventId: event.eventId },
			]);
			expect(harness.session.pendingMessageCount).toBe(0);
		},
	);

	it("settles cancelled-before-dispatch when abort follows finalization", async () => {
		const fixture = await createAdmissionHarness();
		fixtures.push(fixture);
		const { harness, coordinator, manager } = fixture;
		harness.session.refreshContext();
		const event = coordinator.seedEvent("finalized", "FINALIZED_PRIVATE");
		harness.session.requestAdmission.bind(coordinator);
		const owner = harness.session.requestAdmission;
		if (!(owner instanceof RequestAdmissionOwner)) throw new Error("missing owner");
		const original = owner.finalize.bind(owner);
		const outcomes: string[] = [];
		let aborting: Promise<void> | undefined;
		vi.spyOn(owner, "finalize").mockImplementation(async (...args) => {
			const result = await original(...args);
			if (!result) return result;
			aborting = harness.session.abort();
			return {
				...result,
				settle: async (outcome) => {
					outcomes.push(outcome);
					await result.settle(outcome);
				},
			};
		});
		const stream = vi.spyOn(harness.session.agent, "streamFunction");
		const admit = vi.spyOn(coordinator, "admit");
		const assistants = manager
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length;
		await harness.session.prompt("ordinary");
		await aborting;
		const request = coordinator.inspectRequest(admit.mock.calls[0][0].request.requestId);
		expect(request?.suppressed).toBe(true);
		expect(manager.getLeafId()).toBe(admit.mock.calls[0][0].request.branchAnchor);
		const file = manager.getSessionFile();
		if (!file) throw new Error("missing saved session");
		expect(SessionManager.open(file).getLeafId()).toBe(manager.getLeafId());
		expect(outcomes).toEqual(["cancelled-before-dispatch"]);
		expect(stream).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(0);
		expect(coordinator.inspectEvent(event)?.state).toBe("read");
		expect(
			manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "assistant"),
		).toHaveLength(assistants);
		expect(harness.session.messages).toEqual(manager.buildSessionProjection().messages);
	});

	it("settles conservatively when local abort interrupts a held stream function", async () => {
		const fixture = await createAdmissionHarness();
		fixtures.push(fixture);
		const { harness, coordinator, manager } = fixture;
		harness.session.refreshContext();
		const event = coordinator.seedEvent("stream", "STREAM_PRIVATE");
		harness.session.requestAdmission.bind(coordinator);
		const owner = harness.session.requestAdmission;
		if (!(owner instanceof RequestAdmissionOwner)) throw new Error("missing owner");
		const finalize = owner.finalize.bind(owner);
		const outcomes: string[] = [];
		let adopted = 0;
		vi.spyOn(owner, "finalize").mockImplementation(async (...args) => {
			const result = await finalize(...args);
			if (!result) return result;
			return {
				...result,
				onAssistantStart: () => {
					adopted++;
					result.onAssistantStart();
				},
				settle: async (outcome) => {
					outcomes.push(outcome);
					await result.settle(outcome);
				},
			};
		});
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const original = harness.session.agent.streamFunction;
		const stream = vi.spyOn(harness.session.agent, "streamFunction").mockImplementation(async (...args) => {
			entered.resolve();
			await release.promise;
			args[2]?.assertRequestCurrent?.();
			return original(...args);
		});
		const assistants = manager
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length;
		const running = harness.session.prompt("ordinary");
		await entered.promise;
		const root = manager.getLeafId();
		const aborting = harness.session.abort();
		release.resolve();
		await Promise.all([running, aborting]);
		expect(stream).toHaveBeenCalledTimes(1);
		expect(harness.faux.state.callCount).toBe(0);
		expect(coordinator.inspectEvent(event)?.state).toBe("read");
		expect(adopted).toBe(0);
		expect(outcomes).toEqual(["dispatch-uncertain"]);
		expect(manager.getLeafId()).toBe(root);
		expect(
			manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "assistant"),
		).toHaveLength(assistants);
		expect(harness.session.messages).toEqual(manager.buildSessionProjection().messages);
		const file = manager.getSessionFile();
		if (!file) throw new Error("missing saved session");
		expect(SessionManager.open(file).getLeafId()).toBe(root);
	});

	it("aborts immediately before the coordinator send", async () => {
		const fixture = await createAdmissionHarness();
		fixtures.push(fixture);
		const { harness, coordinator, manager } = fixture;
		harness.session.refreshContext();
		const event = coordinator.seedEvent("before-send", "BEFORE_SEND");
		coordinator.seedMatchingConsumption(event, "claim");
		harness.session.requestAdmission.bind(coordinator);
		const workspace = coordinator.workspace.bind(coordinator);
		let aborting: Promise<void> | undefined;
		let root: string | null = null;
		vi.spyOn(coordinator, "workspace").mockImplementation(async (...args) => {
			const result = await workspace(...args);
			root = manager.getLeafId();
			aborting = harness.session.abort();
			return result;
		});
		const snapshot = vi.spyOn(coordinator, "snapshot");
		const delivered = vi.spyOn(coordinator, "delivered");
		const admit = vi.spyOn(coordinator, "admit");
		const stream = vi.spyOn(harness.session.agent, "streamFunction");
		const assistants = manager
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length;
		await harness.session.prompt("ordinary");
		await aborting;
		expect(snapshot).toHaveBeenCalledTimes(1);
		expect(delivered).toHaveBeenCalledTimes(1);
		expect(admit).not.toHaveBeenCalled();
		expect(stream).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(0);
		expect(coordinator.inspectEvent(event)?.state).toBe("pending");
		expect(coordinator.inspectConsumption(event)).toBe("claim");
		expect(manager.getLeafId()).toBe(root);
		expect(
			manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "assistant"),
		).toHaveLength(assistants);
		expect(harness.session.messages).toEqual(manager.buildSessionProjection().messages);
		const file = manager.getSessionFile();
		if (!file) throw new Error("missing saved session");
		expect(SessionManager.open(file).getLeafId()).toBe(root);
	});

	it("aborts while a real candidate-triggered compaction is held", async () => {
		const fixture = await createAdmissionHarness({
			models: [{ id: "faux-1", contextWindow: 5000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } },
		});
		fixtures.push(fixture);
		const { harness, coordinator, manager } = fixture;
		manager.appendContextEdit(manager.getBranch()[0].id, { content: `OLD_HISTORY ${"x".repeat(1000)}` });
		manager.appendMessage(fauxAssistantMessage("old answer"));
		harness.session.refreshContext();
		const event = coordinator.seedEvent("compaction", `UNREAD_PRIVATE ${"y".repeat(12000)}`);
		coordinator.seedMatchingConsumption(event, "claim");
		harness.session.requestAdmission.bind(coordinator);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		harness.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage("summary");
			},
		]);
		const snapshot = vi.spyOn(coordinator, "snapshot");
		const delivered = vi.spyOn(coordinator, "delivered");
		const admit = vi.spyOn(coordinator, "admit");
		const assistants = manager
			.getEntries()
			.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length;
		const running = harness.session.prompt("ordinary");
		await entered.promise;
		const root = manager.getLeafId();
		const aborting = harness.session.abort();
		release.resolve();
		await Promise.all([running, aborting]);
		expect(snapshot).toHaveBeenCalledTimes(1);
		expect(delivered).toHaveBeenCalledTimes(1);
		expect(admit).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(1);
		expect(coordinator.inspectEvent(event)?.state).toBe("pending");
		expect(coordinator.inspectConsumption(event)).toBe("claim");
		expect(manager.getLeafId()).toBe(root);
		expect(
			manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "assistant"),
		).toHaveLength(assistants);
		expect(harness.session.messages).toEqual(manager.buildSessionProjection().messages);
		const file = manager.getSessionFile();
		if (!file) throw new Error("missing saved session");
		expect(SessionManager.open(file).getLeafId()).toBe(root);
	});

	it("revokes tracked resources only once when their callback reenters abort", async () => {
		const fixture = await createAdmissionHarness();
		fixtures.push(fixture);
		const { harness, coordinator, manager } = fixture;
		harness.session.refreshContext();
		const event = coordinator.seedEvent("reentrant", "REENTRANT_PRIVATE");
		coordinator.seedMatchingConsumption(event, "claim");
		harness.session.requestAdmission.bind(coordinator);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const original = coordinator.snapshot.bind(coordinator);
		const snapshot = vi.spyOn(coordinator, "snapshot").mockImplementation(async (...args) => {
			entered.resolve();
			await release.promise;
			return original(...args);
		});
		const delivered = vi.spyOn(coordinator, "delivered");
		const admit = vi.spyOn(coordinator, "admit");
		const stream = vi.spyOn(harness.session.agent, "streamFunction");
		let nestedAbort: Promise<void> | undefined;
		const revoke = vi.fn(() => {
			nestedAbort = harness.session.abort();
		});
		harness.session.runtimeLifecycle.track(fixture.fence, { kind: "wait", id: "reentrant", revoke });
		const running = harness.session.prompt("ordinary");
		await entered.promise;
		const root = manager.getLeafId();
		await harness.session.followUp("queued followup");
		const aborting = harness.session.abort();
		const inspection = harness.session.runtimeLifecycle.inspect();
		release.resolve();
		await Promise.all([running, aborting, nestedAbort]);
		expect(revoke).toHaveBeenCalledTimes(1);
		expect(nestedAbort).toBeDefined();
		expect(inspection).toMatchObject({ epoch: fixture.fence.epoch + 1 });
		expect(snapshot).toHaveBeenCalledTimes(1);
		expect(delivered).not.toHaveBeenCalled();
		expect(admit).not.toHaveBeenCalled();
		expect(stream).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(0);
		expect(coordinator.inspectEvent(event)?.state).toBe("pending");
		expect(coordinator.inspectConsumption(event)).toBe("claim");
		expect(manager.getLeafId()).toBe(root);
		expect(harness.session.pendingMessageCount).toBe(1);
		expect(harness.session.messages).toEqual(manager.buildSessionProjection().messages);
	});

	it("revokes the captured fence synchronously while snapshot is held", async () => {
		const fixture = await createAdmissionHarness();
		fixtures.push(fixture);
		const { harness, coordinator, manager } = fixture;
		harness.session.refreshContext();
		const event = coordinator.seedEvent("snapshot-abort", "SNAPSHOT_PRIVATE");
		coordinator.seedMatchingConsumption(event, "snapshot-claim");
		harness.session.requestAdmission.bind(coordinator);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const original = coordinator.snapshot.bind(coordinator);
		const snapshot = vi.spyOn(coordinator, "snapshot").mockImplementation(async (...args) => {
			entered.resolve();
			await release.promise;
			return original(...args);
		});
		const delivered = vi.spyOn(coordinator, "delivered");
		const admit = vi.spyOn(coordinator, "admit");
		const running = harness.session.prompt("ordinary");
		await entered.promise;
		const root = manager.getLeafId();
		const aborting = harness.session.abort();
		const currentWhileHeld = harness.session.runtimeLifecycle.isCurrent(fixture.fence);
		const epochWhileHeld = harness.session.runtimeLifecycle.inspect();
		release.resolve();
		await Promise.all([running, aborting]);
		expect(currentWhileHeld).toBe(false);
		expect(epochWhileHeld).toMatchObject({ epoch: fixture.fence.epoch + 1 });
		expect(snapshot).toHaveBeenCalledTimes(1);
		expect(delivered).not.toHaveBeenCalled();
		expect(admit).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(0);
		expect(coordinator.inspectEvent(event)?.state).toBe("pending");
		expect(coordinator.inspectConsumption(event)).toBe("snapshot-claim");
		expect(manager.getLeafId()).toBe(root);
		expect(harness.session.messages).toEqual(manager.buildSessionProjection().messages);
		const file = manager.getSessionFile();
		if (!file) throw new Error("missing saved session");
		expect(SessionManager.open(file).getLeafId()).toBe(root);
	});

	it.each(["owned", "navigated", "disconnected"] as const)(
		"handles an already adopted assistant on the %s branch",
		async (branch) => {
			const fixture = await createAdmissionHarness();
			fixtures.push(fixture);
			const { harness, coordinator, manager } = fixture;
			harness.session.refreshContext();
			const event = coordinator.seedEvent("partial", "PARTIAL_PRIVATE");
			harness.session.requestAdmission.bind(coordinator);
			harness.setResponses([fauxAssistantMessage("partial response")]);
			const original = harness.session.agent.streamFunction;
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			harness.session.agent.streamFunction = async (...args) => {
				const stream = await original(...args);
				const iterator = stream[Symbol.asyncIterator]();
				let first = true;
				Object.defineProperty(stream, Symbol.asyncIterator, {
					value: () => ({
						next: async () => {
							if (first) {
								first = false;
								return iterator.next();
							}
							entered.resolve();
							await release.promise;
							return iterator.next();
						},
					}),
				});
				return stream;
			};
			const running = harness.session.prompt("ordinary");
			await entered.promise;
			const adopted = manager.getLeafId();
			const selected = branch === "navigated" ? manager.getBranch()[0].id : adopted;
			if (branch === "navigated") manager.branch(selected!);
			if (branch === "disconnected") harness.session.runtimeLifecycle.disconnect();
			const aborting = harness.session.abort();
			release.resolve();
			await Promise.all([running, aborting]);
			expect(coordinator.inspectEvent(event)?.state).toBe("read");
			expect(harness.faux.state.callCount).toBe(1);
			const assistants = manager
				.getBranch()
				.filter((entry) => entry.type === "message" && entry.message.role === "assistant");
			expect(assistants).toHaveLength(branch === "owned" ? 2 : branch === "disconnected" ? 1 : 0);
			if (branch === "owned") expect(assistants[1].parentId).toBe(adopted);
			else expect(manager.getLeafId()).toBe(selected);
			expect(harness.session.messages).toEqual(manager.buildSessionProjection().messages);
		},
	);

	it.each(["before-append", "after-append"] as const)(
		"preserves committed admission on abort %s",
		async (boundary) => {
			const fixture = await createAdmissionHarness();
			fixtures.push(fixture);
			const { harness, coordinator, manager } = fixture;
			harness.session.refreshContext();
			const event = coordinator.seedEvent(boundary, "COMMITTED_PRIVATE");
			coordinator.seedMatchingConsumption(event, "claim");
			harness.session.requestAdmission.bind(coordinator);
			const original = manager.appendAdmissionBatchOnce.bind(manager);
			let aborting: Promise<void> | undefined;
			let root: string | null = null;
			const append = vi.spyOn(manager, "appendAdmissionBatchOnce").mockImplementation((entries) => {
				root = manager.getLeafId();
				if (boundary === "before-append") aborting = harness.session.abort();
				const result = original(entries);
				if (boundary === "after-append") aborting = harness.session.abort();
				return result;
			});
			const snapshot = vi.spyOn(coordinator, "snapshot");
			const delivered = vi.spyOn(coordinator, "delivered");
			const admit = vi.spyOn(coordinator, "admit");
			const stream = vi.spyOn(harness.session.agent, "streamFunction");
			const assistants = manager
				.getEntries()
				.filter((entry) => entry.type === "message" && entry.message.role === "assistant").length;
			await harness.session.prompt("ordinary");
			await aborting;
			expect(append).toHaveBeenCalledTimes(1);
			expect(snapshot).toHaveBeenCalledTimes(1);
			expect(delivered).toHaveBeenCalledTimes(1);
			expect(admit).toHaveBeenCalledTimes(1);
			expect(stream).not.toHaveBeenCalled();
			expect(harness.faux.state.callCount).toBe(0);
			expect(coordinator.inspectEvent(event)?.state).toBe("read");
			expect(coordinator.inspectConsumption(event)).toBeNull();
			const request = coordinator.inspectRequest(admit.mock.calls[0][0].request.requestId);
			expect(request?.suppressed).toBe(true);
			expect(manager.getEntry(request!.result.entries[0].entryId)).toBeDefined();
			expect(manager.getLeafId()).toBe(root);
			expect(
				manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "assistant"),
			).toHaveLength(assistants);
			expect(harness.session.messages).toEqual(manager.buildSessionProjection().messages);
			const file = manager.getSessionFile();
			if (!file) throw new Error("missing saved session");
			const reopened = SessionManager.open(file);
			expect(reopened.getLeafId()).toBe(root);
			expect(reopened.getEntry(request!.result.entries[0].entryId)).toBeDefined();
		},
	);

	it.each(["before", "after"] as const)(
		"materializes a commit that wins %s local cancellation while its reply waits",
		async (order) => {
			const fixture = await createAdmissionHarness();
			fixtures.push(fixture);
			const { harness, coordinator, manager } = fixture;
			harness.session.refreshContext();
			const event = coordinator.seedEvent("commit-abort", "COMMIT_PRIVATE");
			coordinator.seedMatchingConsumption(event, "commit-claim");
			harness.session.requestAdmission.bind(coordinator);
			const gate = coordinator.holdNextAdmission();
			const snapshot = vi.spyOn(coordinator, "snapshot");
			const delivered = vi.spyOn(coordinator, "delivered");
			const admit = vi.spyOn(coordinator, "admit");
			const running = harness.session.prompt("ordinary");
			await gate.received;
			const root = manager.getLeafId();
			if (order === "before") {
				gate.commit();
				await gate.committed;
			}
			const aborting = harness.session.abort();
			const currentWhileHeld = harness.session.runtimeLifecycle.isCurrent(fixture.fence);
			if (order === "after") {
				gate.commit();
				await gate.committed;
			}
			const requestId = admit.mock.calls[0][0].request.requestId;
			const committed = coordinator.inspectRequest(requestId)?.result;
			gate.respond();
			await Promise.all([running, aborting]);
			expect(currentWhileHeld).toBe(false);
			expect(snapshot).toHaveBeenCalledTimes(1);
			expect(delivered).toHaveBeenCalledTimes(1);
			expect(admit).toHaveBeenCalledTimes(1);
			expect(harness.faux.state.callCount).toBe(0);
			expect(coordinator.inspectEvent(event)?.state).toBe("read");
			expect(coordinator.inspectConsumption(event)).toBeNull();
			expect(coordinator.inspectRequest(requestId)?.suppressed).toBe(true);
			expect(committed?.entries).toHaveLength(1);
			expect(manager.getEntry(committed!.entries[0].entryId)).toBeDefined();
			expect(manager.getLeafId()).toBe(root);
			expect(harness.session.messages).toEqual(manager.buildSessionProjection().messages);
			const file = manager.getSessionFile();
			if (!file) throw new Error("missing saved session");
			const reopened = SessionManager.open(file);
			expect(reopened.getLeafId()).toBe(root);
			expect(reopened.getEntry(committed!.entries[0].entryId)).toBeDefined();
		},
	);
});
