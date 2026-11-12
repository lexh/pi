import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, test, vi } from "vitest";
import { getProcessRuntimeHost } from "../../src/core/runtime-host.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { type BatchCertificate, conversationKeyOf } from "../../src/core/task-finalization.ts";
import { createCoordinationHarness, expectOneAdmission } from "../helpers/coordination.ts";
import { FakeRuntimeCoordinator } from "../helpers/fake-runtime-coordinator.ts";
import { deferred, fixture } from "../helpers/managed-process.ts";
import { createHarness, createTestUiContext } from "./harness.ts";

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
			const helper = {
				attemptId: `retained-helper:${manager.getSessionId()}`,
				runId: "retained-helper-run",
				conversationKey: key,
				kind: "helper" as const,
			};
			// This is a retained helper-attempt fixture, not a Phase 4 service/helper launch proof.
			let running: Promise<void> | undefined;
			let unbind: (() => void) | undefined;
			try {
				await harness.session.bindExtensions({});
				unbind = harness.session.managedProcesses.bind(f.adapter);
				scheduler.bind(coordinator);
				if (retainedHelper) {
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
						f.adapter,
					);
					retained.state.set("task-kind", "helper");
					await retained.opening;
					book.bind(helper);
				}
				harness.setResponses([
					fauxAssistantMessage(fauxToolCall("held_boundary", {}), { stopReason: "toolUse" }),
					fauxAssistantMessage("unused old continuation"),
				]);
				running = harness.session.prompt("end this run");
				await reached.promise;
				const endedId = harness.session.managedAttemptId!;
				expect(book.current(key)?.attemptId).toBe(endedId);
				if (retainedHelper)
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
			// Reloading creates an inert runtime: it participates again, then delivers the retained certificate.
			harness.session.runtimeLifecycle.participate();
			if (scenario === "lost-session") {
				await harness.session.reconcileTaskFinalization(async (retained) => {
					expect(retained).toBe(pending);
					return "committed";
				});
				expect(certificates).toHaveLength(1);
			} else {
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
			harness.cleanup();
			rmSync(directory, { recursive: true, force: true });
		}
	});
}
