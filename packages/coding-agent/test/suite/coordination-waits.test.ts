import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { CoordinationScheduler, WaitOutcome } from "../../src/core/coordination-scheduler-types.ts";
import type { CanonicalEvent, RuntimeFence } from "../../src/index.ts";
import { createCoordinationHarness, expectOneAdmission } from "../helpers/coordination.ts";
import type { FakeRequestCoordinator } from "../helpers/fake-request-coordinator.ts";

describe("coordination scheduler waits and cancellation", () => {
	it("waits before display: tool result persists before admission delivery releases second provider call", async () => {
		let schedulerRef: CoordinationScheduler | undefined;
		const waitPeerTool: AgentTool = {
			name: "wait_peer",
			label: "Wait Peer",
			description: "wait for peer reply",
			parameters: Type.Object({}),
			async execute(_id, _params, signal) {
				const outcome = await schedulerRef!.wait(
					{ kind: "reply", questionId: "q1", addressedIdentity: "parent" },
					Date.now() + 5000,
					signal,
				);
				return {
					content: [{ type: "text", text: JSON.stringify(outcome) }],
					details: outcome,
				};
			},
		};

		const fixture = await createCoordinationHarness({ tools: [waitPeerTool] });
		const { harness, coordinator, manager, scheduler, fence } = fixture;
		schedulerRef = scheduler;
		const unbind = scheduler.bind(coordinator);

		const reply = coordinator.seedEvent("reply-event", "REPLY_PRIVATE_BODY");
		coordinator.omitOrdinaryCandidate(reply);
		coordinator.coordination.registerQuestion("q1", fence.mailboxId, "parent", Date.now() + 10000);

		let capturedWaitId = "";
		const originalWait = vi.spyOn(coordinator, "wait").mockImplementation(async (op, signal) => {
			capturedWaitId = op.operationId;
			return coordinator.coordination.wait(op, signal);
		});

		const deliveryRelease = Promise.withResolvers<void>();
		let holdDelivery = false;
		const originalDelivered = coordinator.delivered.bind(coordinator);
		vi.spyOn(coordinator, "delivered").mockImplementation(async (request, receipts, signal) => {
			if (holdDelivery && receipts.some((r) => r.key.includes("reply-event"))) {
				await deliveryRelease.promise;
			}
			return originalDelivered(request, receipts, signal);
		});

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait_peer", {}, { id: "call-1" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("final response after wait"),
		]);

		const running = harness.session.prompt("start wait run");

		try {
			// Wait until coordinator.wait was called
			await vi.waitFor(() => {
				expect(originalWait).toHaveBeenCalled();
			});

			holdDelivery = true;
			coordinator.coordination.record({
				reference: reply,
				recordedAt: Date.now(),
				match: { kind: "reply", questionId: "q1", senderIdentity: "parent" },
			});

			// Wait until tool execution finishes and persists tool result
			await vi.waitFor(() => {
				const toolResults = harness.session.messages.filter((m) => m.role === "toolResult");
				expect(toolResults).toHaveLength(1);
			});

			expect(harness.faux.state.callCount).toBe(1);
			expect(coordinator.coordination.inspectWait(capturedWaitId)?.result).toEqual({
				waitId: capturedWaitId,
				status: "matched",
				reference: { recipientIdentity: reply.recipientIdentity, eventId: reply.eventId },
			});
			expect(
				JSON.stringify(harness.session.messages.filter((message) => message.role === "toolResult")),
			).not.toContain("REPLY_PRIVATE_BODY");

			deliveryRelease.resolve();
			await running;

			expect(harness.faux.state.callCount).toBe(2);
			expectOneAdmission(manager, reply);
		} finally {
			deliveryRelease.resolve();
			unbind();
			fixture.cleanup();
		}
	});

	it.each([
		{
			scenario: "retained match",
			setup: (coordinator: FakeRequestCoordinator, reply: CanonicalEvent, fence: RuntimeFence) => {
				coordinator.omitOrdinaryCandidate(reply);
				coordinator.coordination.registerQuestion("q-ret", fence.mailboxId, "parent", 10000);
				coordinator.coordination.record({
					reference: reply,
					recordedAt: 1000,
					match: { kind: "reply", questionId: "q-ret", senderIdentity: "parent" },
				});
			},
			target: { kind: "reply" as const, questionId: "q-ret", addressedIdentity: "parent" },
			trigger: (
				_coordinator: FakeRequestCoordinator,
				_reply: CanonicalEvent,
				_advanceClock: (ms: number) => void,
			) => {},
			expectedStatus: "matched",
		},
		{
			scenario: "future match",
			setup: (coordinator: FakeRequestCoordinator, _reply: CanonicalEvent, fence: RuntimeFence) => {
				coordinator.coordination.registerQuestion("q-fut", fence.mailboxId, "parent", 10000);
			},
			target: { kind: "reply" as const, questionId: "q-fut", addressedIdentity: "parent" },
			trigger: (
				coordinator: FakeRequestCoordinator,
				_reply: CanonicalEvent,
				_advanceClock: (ms: number) => void,
			) => {
				const event = coordinator.seedEvent("event-fut-reply", "BODY");
				coordinator.coordination.record({
					reference: event,
					recordedAt: 1100,
					match: { kind: "reply", questionId: "q-fut", senderIdentity: "parent" },
				});
			},
			expectedStatus: "matched",
		},
		{
			scenario: "timeout",
			setup: (_coordinator: FakeRequestCoordinator, _reply: CanonicalEvent, _fence: RuntimeFence) => {},
			target: { kind: "job" as const, attemptId: "job-timeout" },
			trigger: (coordinator: FakeRequestCoordinator, _reply: CanonicalEvent, advanceClock: (ms: number) => void) => {
				advanceClock(2000);
				coordinator.coordination.finishDue();
			},
			expectedStatus: "timeout",
		},
		{
			scenario: "unanswerable",
			setup: (coordinator: FakeRequestCoordinator, _reply: CanonicalEvent, fence: RuntimeFence) => {
				coordinator.coordination.registerQuestion("q-unans", fence.mailboxId, "parent", 10000);
			},
			target: { kind: "reply" as const, questionId: "q-unans", addressedIdentity: "parent" },
			trigger: (
				coordinator: FakeRequestCoordinator,
				_reply: CanonicalEvent,
				_advanceClock: (ms: number) => void,
			) => {
				coordinator.coordination.makeUnanswerable("q-unans", "parent-closed");
			},
			expectedStatus: "unanswerable",
		},
	])("exact two-call positive for $scenario", async ({ setup, target, trigger, expectedStatus }) => {
		let testTime = 1000;
		const clock = () => testTime;
		const advanceClock = (delta: number) => {
			testTime += delta;
		};

		let capturedOutcome: WaitOutcome | undefined;
		let schedulerRef: CoordinationScheduler | undefined;
		const waitRegistered: PromiseWithResolvers<void> = Promise.withResolvers<void>();

		const waitTool: AgentTool = {
			name: "wait_tool",
			label: "Wait Tool",
			description: "wait",
			parameters: Type.Object({}),
			async execute(_id, _params, signal) {
				waitRegistered.resolve();
				const outcome = await schedulerRef!.wait(target, testTime + 500, signal);
				capturedOutcome = outcome;
				return { content: [{ type: "text", text: JSON.stringify(outcome) }], details: outcome };
			},
		};

		const fixture = await createCoordinationHarness({ clock, tools: [waitTool] });
		const { harness, coordinator, scheduler, fence } = fixture;
		schedulerRef = scheduler;
		const unbind = scheduler.bind(coordinator);

		const reply = coordinator.seedEvent(`event-${target.kind}`, "BODY");
		setup(coordinator, reply, fence);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait_tool", {}, { id: "call-wait" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("second call output"),
		]);

		const running = harness.session.prompt("start wait");

		try {
			await waitRegistered.promise;
			trigger(coordinator, reply, advanceClock);

			await running;
			expect(harness.faux.state.callCount).toBe(2);
			expect(capturedOutcome?.status).toBe(expectedStatus);
		} finally {
			unbind();
			fixture.cleanup();
		}
	});

	it("interrupted wait with sibling tool: sibling finishes, 1 provider call total, no dangling IDs", async () => {
		const slowGate = Promise.withResolvers<void>();
		let slowStarted = false;
		let waitStarted = false;

		const siblingTool: AgentTool = {
			name: "sibling_tool",
			label: "Sibling Tool",
			description: "slow sibling",
			parameters: Type.Object({}),
			async execute() {
				slowStarted = true;
				await slowGate.promise;
				return { content: [{ type: "text", text: "sibling done" }], details: {} };
			},
		};

		let waitOutcome: WaitOutcome | undefined;
		let schedulerRef: CoordinationScheduler | undefined;
		const waitTool: AgentTool = {
			name: "wait_peer",
			label: "Wait Peer",
			description: "wait",
			parameters: Type.Object({}),
			async execute(_id, _params, signal) {
				waitStarted = true;
				waitOutcome = await schedulerRef!.wait({ kind: "job", attemptId: "job-sib" }, Date.now() + 10000, signal);
				return { content: [{ type: "text", text: JSON.stringify(waitOutcome) }], details: waitOutcome };
			},
		};

		const fixture = await createCoordinationHarness({ tools: [siblingTool, waitTool] });
		const { harness, coordinator, scheduler } = fixture;
		schedulerRef = scheduler;
		const unbind = scheduler.bind(coordinator);

		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("sibling_tool", {}, { id: "call-slow" }), fauxToolCall("wait_peer", {}, { id: "call-wait" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("should not happen"),
		]);

		const running = harness.session.prompt("start batch");

		try {
			await vi.waitFor(() => {
				expect(slowStarted).toBe(true);
				expect(waitStarted).toBe(true);
			});

			// Cancel scheduler while batch is active
			scheduler.cancel();

			// Wait tool finishes immediately with interrupted
			await vi.waitFor(() => {
				expect(waitOutcome?.status).toBe("interrupted");
			});

			// Release sibling tool
			slowGate.resolve();
			await running;

			// Exactly 1 provider call, no continuation
			expect(harness.faux.state.callCount).toBe(1);

			// Both tool results are saved/persisted
			const toolResults = harness.session.messages.filter((m) => m.role === "toolResult");
			expect(toolResults).toHaveLength(2);
			expect(toolResults.map((r: any) => r.toolCallId).sort()).toEqual(["call-slow", "call-wait"]);
		} finally {
			slowGate.resolve();
			unbind();
			fixture.cleanup();
		}
	});

	it("cancels locally when lifecycle is disconnected without throwing", async () => {
		const fixture = await createCoordinationHarness();
		const { harness, coordinator, scheduler } = fixture;
		const unbind = scheduler.bind(coordinator);

		const grant = await scheduler.grant({ kind: "job", attemptId: "job-offline" });
		expect(grant.state).toBe("armed");

		// Disconnect runtime lifecycle directly
		harness.session.runtimeLifecycle.disconnect();
		expect(() => harness.session.runtimeLifecycle.capture()).toThrow("Runtime attachment is not verified");

		// Scheduler cancel must succeed locally despite disconnected lifecycle
		expect(() => scheduler.cancel()).not.toThrow();

		const inspection = scheduler.inspect();
		expect(inspection.permissionEpoch).toBe(1);
		expect(inspection.pendingClaim).toBe(false);
		expect(inspection.grants.find((g) => g.grantId === grant.grantId)?.state).toBe("revoked");

		unbind();
		fixture.cleanup();
	});

	it("retries offline cancellation on reconcile after reconnect, remotely revoking grant and refusing late old-epoch grant", async () => {
		const fixture = await createCoordinationHarness();
		const { harness, coordinator, scheduler, runtimeCoordinator } = fixture;
		const unbind = scheduler.bind(coordinator);

		const grant = await scheduler.grant({ kind: "job", attemptId: "job-offline-reconcile" });
		expect(grant.state).toBe("armed");
		expect(coordinator.coordination.inspectGrant(grant.grantId)?.state).toBe("armed");

		// Disconnect runtime lifecycle directly
		harness.session.runtimeLifecycle.disconnect();

		// Local cancel while disconnected
		scheduler.cancel();
		expect(scheduler.inspect().grants.find((g) => g.grantId === grant.grantId)?.state).toBe("revoked");

		// Reconnect and reconcile
		await harness.session.runtimeLifecycle.reconcile(runtimeCoordinator.exchange);
		await scheduler.reconcile();

		// Remote coordinator must now see the grant revoked
		expect(coordinator.coordination.inspectGrant(grant.grantId)?.state).toBe("revoked");

		// Late old-epoch grant must be refused
		const fence = harness.session.runtimeLifecycle.capture();
		await expect(
			coordinator.grant({
				operationId: "late-grant-old-epoch",
				scope: { fence, permissionEpoch: 0 },
				target: { kind: "job", attemptId: "job-late" },
			}),
		).rejects.toThrow("Stale permission epoch");

		unbind();
		fixture.cleanup();
	});

	it("observer cancel followed by session.abort is idempotent with one scope transition and no redundant RPCs", async () => {
		const fixture = await createCoordinationHarness();
		const { harness, coordinator, scheduler } = fixture;
		const unbind = scheduler.bind(coordinator);

		const grant = await scheduler.grant({ kind: "job", attemptId: "job-observer-abort" });
		expect(grant.state).toBe("armed");

		const cancelSpy = vi.spyOn(coordinator, "cancelPermissions");

		// Physical Esc observer calls scheduler.cancel()
		scheduler.cancel();
		expect(scheduler.inspect().permissionEpoch).toBe(1);
		expect(cancelSpy).toHaveBeenCalledTimes(1);

		// Subsequent session.abort() calls scheduler.cancel() again
		await harness.session.abort();

		// Permission epoch must remain 1 (no redundant second increment/RPC)
		expect(scheduler.inspect().permissionEpoch).toBe(1);
		expect(cancelSpy).toHaveBeenCalledTimes(1);

		unbind();
		fixture.cleanup();
	});

	it("new prompt after cancel does not regrant revoked grant", async () => {
		const fixture = await createCoordinationHarness();
		const { harness, coordinator, scheduler } = fixture;
		const unbind = scheduler.bind(coordinator);

		const grant = await scheduler.grant({ kind: "job", attemptId: "job-no-regrant" });
		expect(grant.state).toBe("armed");

		scheduler.cancel();
		expect(scheduler.inspect().grants.find((g) => g.grantId === grant.grantId)?.state).toBe("revoked");

		harness.setResponses([fauxAssistantMessage("reply")]);
		await harness.session.prompt("new prompt");

		// Grant is still revoked, not rearmed
		expect(scheduler.inspect().grants.find((g) => g.grantId === grant.grantId)?.state).toBe("revoked");

		unbind();
		fixture.cleanup();
	});
});
