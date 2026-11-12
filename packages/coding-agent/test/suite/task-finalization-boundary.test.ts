import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { expect, test, vi } from "vitest";
import type { ManagedProcessAdapter } from "../../src/core/managed-process-types.ts";
import { getProcessRuntimeHost } from "../../src/core/runtime-host.ts";
import { resolveConversationBinding } from "../../src/core/runtime-incarnation.ts";
import type { ConversationBinding } from "../../src/core/runtime-lifecycle-types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { type BatchCertificate, conversationKeyOf } from "../../src/core/task-finalization.ts";
import { createCoordinationHarness, expectOneAdmission } from "../helpers/coordination.ts";
import { FakeRuntimeCoordinator } from "../helpers/fake-runtime-coordinator.ts";
import { deferred, fixture } from "../helpers/managed-process.ts";
import { createHarness, createTestUiContext, type Harness } from "./harness.ts";

/**
 * A retained helper-attempt fixture on the process-owned book, as a helper task leaves it: bound to the conversation
 * of the harness session, with no run of its own. It is not a Phase 4 service or helper launch.
 */
async function retainHelper(harness: Harness, adapter: ManagedProcessAdapter, conversation: ConversationBinding) {
	const host = getProcessRuntimeHost();
	const helper = {
		attemptId: `retained-helper:${harness.sessionManager.getSessionId()}`,
		runId: "retained-helper-run",
		conversationKey: conversationKeyOf(conversation),
		kind: "helper" as const,
	};
	const fence = harness.session.runtimeLifecycle.capture();
	const retained = host.processes.begin(
		{
			operationId: helper.attemptId,
			attemptId: helper.attemptId,
			marker: helper.attemptId,
			runId: helper.runId,
			provenance: {
				hostId: fence.hostId,
				instanceId: fence.instanceId,
				incarnation: fence.incarnation,
				conversation: { ...conversation },
			},
		},
		fence,
		adapter,
	);
	retained.state.set("task-kind", "helper");
	await retained.opening;
	host.taskFinalizations.bind(helper);
	return helper;
}

// A stopped or ended inline run vetoes only itself: a later wake and an unbound ordinary run proceed. A stopped
// helper, whose task has ended for good, vetoes every later automatic start of its conversation.
for (const terminal of ["stopped", "ended"] as const) {
	for (const retainedHelper of [false, true]) {
		test(`${terminal} inline run settles before fresh wake, retainedHelper=${retainedHelper}`, async () => {
			const reached = deferred<void>();
			const release = deferred<void>();
			const certificates: BatchCertificate[] = [];
			// An ended run declares its completion once; a stopped one is stopped from outside.
			let declareOnce = terminal === "ended";
			const f = fixture({
				finalize: async (certificate) => {
					certificates.push(structuredClone(certificate));
					return "committed";
				},
			});
			const coordinated = await createCoordinationHarness({
				settings: { cacheWarming: "off", compaction: { enabled: false } },
				initialActiveToolNames: ["held_boundary"],
				extensionFactories: [
					(pi) => {
						pi.declareProcessCoverage("no-spawn");
						pi.registerTool({
							name: "held_boundary",
							label: "held",
							description: "hold a real whole-batch boundary",
							processCoverage: "no-spawn",
							parameters: Type.Object({}),
							execute: async (toolCallId, _params, _signal, _update, ctx) => {
								reached.resolve();
								if (declareOnce) {
									declareOnce = false;
									ctx.managedProcesses.declareTaskFinalization({
										operationId: "inline-end",
										claim: "claimed-success",
										declarationToolCallId: toolCallId,
									});
								}
								await release.promise;
								return { content: [{ type: "text", text: "finished" }], details: {} };
							},
						});
					},
				],
			});
			const { harness, manager, scheduler, coordinator } = coordinated;
			const inspected = harness.session.runtimeLifecycle.inspect();
			if (inspected.state === "unavailable" || !inspected.conversation)
				throw new Error("Expected a participating runtime");
			const conversation = inspected.conversation;
			const key = conversationKeyOf(conversation);
			const host = getProcessRuntimeHost();
			const book = host.taskFinalizations;
			let helper: Awaited<ReturnType<typeof retainHelper>> | undefined;
			let running: Promise<void> | undefined;
			let unbind: (() => void) | undefined;
			try {
				await harness.session.bindExtensions({});
				unbind = harness.session.managedProcesses.bind(f.adapter);
				scheduler.bind(coordinator);
				if (retainedHelper) helper = await retainHelper(harness, f.adapter, conversation);
				harness.setResponses([
					fauxAssistantMessage(fauxToolCall("held_boundary", {}), { stopReason: "toolUse" }),
					fauxAssistantMessage("unused old continuation"),
				]);
				running = harness.session.prompt("end this run");
				await reached.promise;
				const endedId = harness.session.managedAttemptId!;
				expect(book.current(key)?.attemptId).toBe(endedId);
				if (helper)
					await harness.session.managedProcesses.requestStop(helper.attemptId, "retained-helper-stop").settled;
				const stop =
					terminal === "stopped" ? harness.session.managedProcesses.requestStop(endedId, "first-stop") : undefined;
				release.resolve();
				await running;
				await stop?.settled;
				await harness.session.waitForIdle();
				expect(harness.faux.state.callCount).toBe(1);
				expect(certificates.map((certificate) => certificate.attemptId)).toEqual(
					terminal === "ended" ? [endedId] : [],
				);
				expect(book.blocks(key)).toBe(retainedHelper);
				await harness.session.runtimeLifecycle.reconcile(coordinated.runtimeCoordinator.exchange);
				const event = coordinator.seedEvent("fresh-after-end", "FRESH_WAKE_BODY");
				coordinator.coordination.record({
					reference: event,
					recordedAt: Date.now(),
					match: { kind: "job", attemptId: "fresh-job" },
				});
				harness.setResponses([fauxAssistantMessage("fresh wake response")]);
				const grant = await scheduler.grant({ kind: "job", attemptId: "fresh-job" });
				await scheduler.refresh();
				if (retainedHelper) {
					for (let n = 0; n < 10; n++) await scheduler.refresh();
					await new Promise((resolve) => setTimeout(resolve, 20));
					expect(harness.faux.state.callCount).toBe(1);
					expect(coordinator.inspectEvent(event)?.state).toBe("pending");
					expect(scheduler.inspect().grants.find((value) => value.grantId === grant.grantId)?.state).not.toBe(
						"consumed",
					);
				} else {
					await vi.waitFor(() => {
						expect(harness.faux.state.callCount).toBe(2);
					});
					await harness.session.waitForIdle();
					expectOneAdmission(manager, event);
					expect(f.opened).toHaveLength(2);
					expect(f.opened[1]!.attemptId).not.toBe(endedId);
					unbind();
					unbind = undefined;
					harness.setResponses([
						fauxAssistantMessage(fauxToolCall("held_boundary", {}), { stopReason: "toolUse" }),
						fauxAssistantMessage("ordinary unbound continuation"),
					]);
					await harness.session.prompt("ordinary run after unbinding");
					expect(harness.faux.state.callCount).toBe(4);
					expect(f.opened).toHaveLength(2);
				}
			} finally {
				release.resolve();
				await running?.catch(() => {});
				unbind?.();
				coordinated.cleanup();
			}
		});
	}
}

// The provider is the faux one, so its call count is the number of requests the session made.
for (const scenario of ["answered", "slow", "lost-session", "lost-facade"] as const) {
	test(`whole-batch finishTurn suppresses extra requests, ${scenario}`, async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-final-batch-"));
		const edited = join(directory, "edited");
		const manager = SessionManager.create(directory, join(directory, "sessions"));
		manager.persistNow();
		const delayed = deferred<void>();
		const reached = deferred<void>();
		const late = deferred<void>();
		const certificates: BatchCertificate[] = [];
		const notices: string[] = [];
		let attemptId: string | undefined;
		const f = fixture({
			finalize: async (certificate) => {
				certificates.push(structuredClone(certificate));
				if (scenario === "slow") await late.promise;
				// The first response is lost; the recovery sends the same frozen certificate again.
				if (scenario.startsWith("lost") && certificates.length === 1) throw new Error("offline finalizer");
				return "committed";
			},
		});
		const harness = await createHarness({
			sessionManager: manager,
			settings: { cacheWarming: "off", compaction: { enabled: false } },
			initialActiveToolNames: ["declare_complete", "delayed_edit", "failed_test"],
			extensionFactories: [
				(pi) => {
					pi.declareProcessCoverage("no-spawn");
					pi.registerTool({
						name: "declare_complete",
						label: "complete",
						description: "declare pending task completion",
						processCoverage: "no-spawn",
						parameters: Type.Object({}),
						execute: async (toolCallId, _params, _signal, _update, ctx) => {
							ctx.managedProcesses.declareTaskFinalization({
								operationId: "one-certificate",
								claim: "claimed-success",
								declarationToolCallId: toolCallId,
							});
							return { content: [{ type: "text", text: "pending whole batch" }], details: {} };
						},
					});
					pi.registerTool({
						name: "delayed_edit",
						label: "edit",
						description: "delayed fixture edit",
						processCoverage: "no-spawn",
						parameters: Type.Object({}),
						execute: async () => {
							reached.resolve();
							await delayed.promise;
							writeFileSync(edited, "finished");
							return { content: [{ type: "text", text: "edited" }], details: {} };
						},
					});
					pi.registerTool({
						name: "failed_test",
						label: "test",
						description: "intentional sibling failure",
						processCoverage: "no-spawn",
						parameters: Type.Object({}),
						execute: async () => {
							throw new Error("fixture sibling failed");
						},
					});
				},
			],
		});
		let running: Promise<void> | undefined;
		try {
			await harness.session.bindExtensions({
				uiContext: createTestUiContext({ notify: (message) => notices.push(message) }),
			});
			harness.session.runtimeLifecycle.participate();
			await harness.session.runtimeLifecycle.reconcile(new FakeRuntimeCoordinator().exchange);
			harness.session.managedProcesses.bind(f.adapter);
			harness.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall("declare_complete", {}),
						fauxToolCall("delayed_edit", {}),
						fauxToolCall("failed_test", {}),
					],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("must remain unused"),
			]);
			running = harness.session.prompt("execute one declared whole batch");
			await reached.promise;
			attemptId = harness.session.managedAttemptId;
			// The declaration alone ends nothing: its siblings are still running.
			expect(existsSync(edited)).toBe(false);
			expect(certificates).toHaveLength(0);
			delayed.resolve();
			const released = performance.now();
			await running;
			expect(existsSync(edited)).toBe(true);
			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.getPendingResponseCount()).toBe(1);
			expect(certificates).toHaveLength(1);
			const cert = certificates[0]!;
			expect(cert.toolResults).toHaveLength(3);
			expect(cert.toolResults.filter((value) => value.isError)).toHaveLength(1);
			expect(cert.declarationBeforeResults).toBe(true);
			expect(cert.claim).toBe("claimed-success");
			const book = getProcessRuntimeHost().taskFinalizations;
			if (scenario === "answered") {
				expect(book.pending(attemptId!)).toBeUndefined();
				expect(notices).toEqual([]);
				return;
			}
			const pending = book.pending(attemptId!)!;
			expect(pending.operationId).toBe("one-certificate");
			if (scenario === "slow") {
				// The run waits one second for the answer, then ends with the same operation still in flight.
				expect(performance.now() - released).toBeGreaterThanOrEqual(900);
				expect(notices).toEqual([expect.stringContaining("timed out")]);
				expect(book.pending(attemptId!)).toBe(pending);
				late.resolve();
				await vi.waitFor(() => {
					expect(book.pending(attemptId!)).toBeUndefined();
				});
				expect(certificates).toHaveLength(1);
				return;
			}
			// The lost response leaves one certificate in the process-owned book, and the user is told.
			expect(notices).toEqual([expect.stringContaining("offline finalizer")]);
			await harness.session.reload();
			expect(book.pending(attemptId!)).toBe(pending);
			// Reloading creates an inert runtime that has no conversation until it participates again.
			const reloaded = harness.session.runtimeLifecycle.inspect();
			expect(reloaded.state === "unavailable" ? undefined : reloaded.conversation).toBeUndefined();
			if (scenario === "lost-session") {
				// The caller's own route needs neither a participating runtime nor a bound adapter.
				const delivered: BatchCertificate[] = [];
				await harness.session.reconcileTaskFinalization(async (retained) => {
					delivered.push(retained);
					return "committed";
				});
				expect(delivered).toHaveLength(1);
				expect(delivered[0]).toBe(pending);
				expect(certificates).toHaveLength(1);
			} else {
				// Binding an adapter does need the runtime to participate again.
				harness.session.runtimeLifecycle.participate();
				harness.session.managedProcesses.bind(f.adapter);
				await harness.session.managedProcesses.reconcileFinalizations();
				expect(certificates).toHaveLength(2);
				expect(certificates[1]).toEqual(cert);
			}
			expect(book.pending(attemptId!)).toBeUndefined();
			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.getPendingResponseCount()).toBe(1);
		} finally {
			delayed.resolve();
			late.resolve();
			await running?.catch(() => {});
			// The book is process wide: a certificate this test left pending must not reach another test's reconcile.
			if (attemptId) await getProcessRuntimeHost().taskFinalizations.reconcile(attemptId, async () => "superseded");
			harness.cleanup();
			rmSync(directory, { recursive: true, force: true });
		}
	});
}

// A stopped or ended helper latches its conversation for good, and the latch outlives a reload. The reloaded runtime
// has no conversation until it participates again, but the run it continues must still end after its tool batch.
for (const helperState of ["active", "stopped", "ended"] as const) {
	test(`${helperState} helper latch holds across reload before the runtime participates again`, async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-helper-reload-"));
		const manager = SessionManager.create(directory, join(directory, "sessions"));
		manager.persistNow();
		const f = fixture();
		const harness = await createHarness({
			sessionManager: manager,
			settings: { cacheWarming: "off", compaction: { enabled: false } },
			initialActiveToolNames: ["quick_tool"],
			extensionFactories: [
				(pi) => {
					pi.declareProcessCoverage("no-spawn");
					pi.registerTool({
						name: "quick_tool",
						label: "quick",
						description: "return at once",
						processCoverage: "no-spawn",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "quick" }], details: {} }),
					});
				},
			],
		});
		try {
			await harness.session.bindExtensions({});
			harness.session.runtimeLifecycle.participate();
			await harness.session.runtimeLifecycle.reconcile(new FakeRuntimeCoordinator().exchange);
			harness.session.managedProcesses.bind(f.adapter);
			const inspected = harness.session.runtimeLifecycle.inspect();
			if (inspected.state === "unavailable" || !inspected.conversation)
				throw new Error("Expected a participating runtime");
			const helper = await retainHelper(harness, f.adapter, inspected.conversation);
			const book = getProcessRuntimeHost().taskFinalizations;
			if (helperState === "stopped")
				await harness.session.managedProcesses.requestStop(helper.attemptId, "helper-stop").settled;
			if (helperState === "ended") {
				// What the full-batch boundary does to a helper's task: stage its declaration, then see the whole batch.
				book.stage(helper, {
					operationId: "helper-end",
					claim: "claimed-success",
					declarationToolCallId: "finish",
				});
				book.boundary(helper, {
					aborted: false,
					toolResults: [{ toolCallId: "finish", isError: false }],
					registryThrough: 1,
				});
				// The book is process wide: consume the certificate here, so no other test's reconcile finds it.
				await book.reconcile(helper.attemptId, async () => "committed");
			}
			expect(book.blocks(helper.conversationKey)).toBe(helperState !== "active");

			await harness.session.reload();
			const reloaded = harness.session.runtimeLifecycle.inspect();
			expect(reloaded.state === "unavailable" ? undefined : reloaded.conversation).toBeUndefined();
			// A reload resets the API provider registry, which drops the harness' faux provider.
			const revived = registerFauxProvider({ api: harness.faux.api });
			try {
				revived.setResponses([
					fauxAssistantMessage(fauxToolCall("quick_tool", {}), { stopReason: "toolUse" }),
					fauxAssistantMessage("second response"),
				]);
				await harness.session.prompt("run after the reload");
				// A latched conversation ends its run after the tool batch; otherwise the model gets its second turn.
				expect(revived.state.callCount).toBe(helperState === "active" ? 2 : 1);
				expect(revived.getPendingResponseCount()).toBe(helperState === "active" ? 0 : 1);
			} finally {
				revived.unregister();
			}
		} finally {
			harness.cleanup();
			rmSync(directory, { recursive: true, force: true });
		}
	});
}

test("the task conversation key comes from the session until the runtime has a conversation, and follows the session", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-task-key-"));
	const manager = SessionManager.create(directory, join(directory, "sessions"));
	const harness = await createHarness({
		sessionManager: manager,
		settings: { cacheWarming: "off", compaction: { enabled: false } },
	});
	const keyOf = () =>
		(harness.session as unknown as { _taskConversationKey(): string | undefined })._taskConversationKey();
	try {
		// Nothing is saved yet: there is no key, and asking does not save the session.
		expect(keyOf()).toBeUndefined();
		expect(existsSync(manager.getSessionFile()!)).toBe(false);
		manager.persistNow();
		const key = conversationKeyOf(resolveConversationBinding(manager));
		expect(keyOf()).toBe(key);
		// A session switched in place has its own key, and an unsaved one none; the first key is not kept.
		manager.newSession();
		expect(keyOf()).toBeUndefined();
		manager.persistNow();
		const next = conversationKeyOf(resolveConversationBinding(manager));
		expect(next).not.toBe(key);
		expect(keyOf()).toBe(next);
		// Once the runtime participates its own conversation names the same key.
		harness.session.runtimeLifecycle.participate();
		expect(keyOf()).toBe(next);
	} finally {
		harness.cleanup();
		rmSync(directory, { recursive: true, force: true });
	}
});
