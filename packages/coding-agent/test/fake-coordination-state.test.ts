import { describe, expect, it } from "vitest";
import type { CanonicalEvent, ExternalEventReference } from "../src/core/request-admission-types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { FakeCoordinationState } from "./helpers/fake-coordination-state.ts";
import { createAdmissionHarness } from "./helpers/request-admission.ts";
import { createHarness } from "./suite/harness.ts";

function toRef(event: CanonicalEvent): ExternalEventReference {
	return { recipientIdentity: event.recipientIdentity, eventId: event.eventId };
}

describe("fake coordination authority", () => {
	it("matches reply wait only when addressed sender and question ID match", async () => {
		const fixture = await createAdmissionHarness();
		const { coordinator, fence } = fixture;
		const now = Date.now();
		coordinator.coordination.registerQuestion("q", fence.mailboxId, "parent", now + 1000);

		const wrong = coordinator.seedEvent("wrong-reply", "body");
		const right = coordinator.seedEvent("right-reply", "body");

		const wait = coordinator.wait({
			operationId: "wait-1",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "reply", questionId: "q", addressedIdentity: "parent" },
			deadline: now + 500,
		});

		coordinator.coordination.record({
			reference: wrong,
			recordedAt: now,
			match: { kind: "reply", questionId: "q", senderIdentity: "stranger" },
		});
		expect(coordinator.coordination.inspectWait("wait-1")?.result).toBeUndefined();

		coordinator.coordination.record({
			reference: right,
			recordedAt: now + 100,
			match: { kind: "reply", questionId: "q", senderIdentity: "parent" },
		});

		coordinator.coordination.finishDue();
		await expect(wait).resolves.toEqual({ waitId: "wait-1", status: "matched", reference: toRef(right) });
		expect(coordinator.coordination.inspectWait("wait-1")?.terminalCount).toBe(1);
	});

	it("does not match signal with correlation or name or sender mismatch", async () => {
		const fixture = await createAdmissionHarness();
		const { coordinator, fence } = fixture;
		const now = Date.now();

		const wrongSender = coordinator.seedEvent("wrong-sender", "body");
		const wrongName = coordinator.seedEvent("wrong-name", "body");
		const wrongCorr = coordinator.seedEvent("wrong-corr", "body");
		const right = coordinator.seedEvent("right-signal", "body");

		const wait = coordinator.wait({
			operationId: "wait-sig",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "signal", senderIdentity: "peer", name: "ping", correlation: "c1" },
			deadline: now + 500,
		});

		coordinator.coordination.record({
			reference: wrongSender,
			recordedAt: now,
			match: { kind: "signal", senderIdentity: "other", name: "ping", correlation: "c1" },
		});
		coordinator.coordination.record({
			reference: wrongName,
			recordedAt: now,
			match: { kind: "signal", senderIdentity: "peer", name: "pong", correlation: "c1" },
		});
		coordinator.coordination.record({
			reference: wrongCorr,
			recordedAt: now,
			match: { kind: "signal", senderIdentity: "peer", name: "ping", correlation: "c2" },
		});
		expect(coordinator.coordination.inspectWait("wait-sig")?.result).toBeUndefined();

		coordinator.coordination.record({
			reference: right,
			recordedAt: now + 50,
			match: { kind: "signal", senderIdentity: "peer", name: "ping", correlation: "c1" },
		});

		await expect(wait).resolves.toEqual({ waitId: "wait-sig", status: "matched", reference: toRef(right) });
	});

	it("does not match job when attemptId mismatches", async () => {
		const fixture = await createAdmissionHarness();
		const { coordinator, fence } = fixture;
		const now = Date.now();

		const wrong = coordinator.seedEvent("wrong-job", "body");
		const right = coordinator.seedEvent("right-job", "body");

		const wait = coordinator.wait({
			operationId: "wait-job",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "job", attemptId: "attempt-1" },
			deadline: now + 500,
		});

		coordinator.coordination.record({
			reference: wrong,
			recordedAt: now,
			match: { kind: "job", attemptId: "attempt-2" },
		});
		expect(coordinator.coordination.inspectWait("wait-job")?.result).toBeUndefined();

		coordinator.coordination.record({
			reference: right,
			recordedAt: now + 50,
			match: { kind: "job", attemptId: "attempt-1" },
		});
		await expect(wait).resolves.toEqual({ waitId: "wait-job", status: "matched", reference: toRef(right) });
	});

	it("matches attempt waits with checkpoint/report alternation and excludes previously matched within instance", async () => {
		const fixture = await createAdmissionHarness();
		const { coordinator, fence } = fixture;
		const now = Date.now();

		const reportEvent = coordinator.seedEvent("report-1", "body");
		const checkpointEvent = coordinator.seedEvent("checkpoint-1", "body");

		coordinator.coordination.record({
			reference: reportEvent,
			recordedAt: now,
			match: { kind: "attempt", attemptId: "att-x", eventKind: "report" },
		});
		coordinator.coordination.record({
			reference: checkpointEvent,
			recordedAt: now + 10,
			match: { kind: "attempt", attemptId: "att-x", eventKind: "checkpoint" },
		});

		const wait1 = await coordinator.wait({
			operationId: "wait-att-1",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "attempt", attemptId: "att-x" },
			deadline: now + 500,
		});
		expect(wait1).toEqual({ waitId: "wait-att-1", status: "matched", reference: toRef(reportEvent) });

		const wait2 = await coordinator.wait({
			operationId: "wait-att-2",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "attempt", attemptId: "att-x" },
			deadline: now + 500,
		});
		expect(wait2).toEqual({ waitId: "wait-att-2", status: "matched", reference: toRef(checkpointEvent) });

		// Third wait has no more unadmitted, unmatched events for this instance -> times out
		const clockTime = now + 600;
		const fixtureWithClock = await createAdmissionHarness({ clock: () => clockTime });
		const wait3 = fixtureWithClock.coordinator.wait({
			operationId: "wait-att-3",
			scope: { fence: fixtureWithClock.fence, permissionEpoch: 0 },
			target: { kind: "attempt", attemptId: "att-x" },
			deadline: clockTime,
		});
		fixtureWithClock.coordinator.coordination.finishDue();
		await expect(wait3).resolves.toEqual({ waitId: "wait-att-3", status: "timeout", deadline: clockTime });
	});

	it("recovers matched-but-unadmitted attempt event to a fresh instance", async () => {
		const fixture = await createAdmissionHarness();
		const { coordinator, fence } = fixture;
		const now = Date.now();

		const reportEvent = coordinator.seedEvent("report-att", "body");
		coordinator.coordination.record({
			reference: reportEvent,
			recordedAt: now,
			match: { kind: "attempt", attemptId: "att-fresh", eventKind: "report" },
		});

		const wait1 = await coordinator.wait({
			operationId: "wait-fresh-1",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "attempt", attemptId: "att-fresh" },
			deadline: now + 500,
		});
		expect(wait1.status).toBe("matched");

		// Retire old instance to free mailbox, simulating crash/restart
		const sessionFile = fixture.manager.getSessionFile()!;
		fixture.runtimeCoordinator.detachMailbox(fence.mailboxId);
		fixture.harness.session.dispose();

		// Fresh instance on the same session
		const reopened = SessionManager.open(sessionFile);
		const fixture2 = await createHarness({ sessionManager: reopened });
		fixture2.session.runtimeLifecycle.participate();
		await fixture2.session.runtimeLifecycle.reconcile(fixture.runtimeCoordinator.exchange);
		const freshFence = fixture2.session.runtimeLifecycle.capture();

		const waitFresh = await coordinator.wait({
			operationId: "wait-fresh-2",
			scope: { fence: freshFence, permissionEpoch: 0 },
			target: { kind: "attempt", attemptId: "att-fresh" },
			deadline: now + 500,
		});
		expect(waitFresh).toEqual({ waitId: "wait-fresh-2", status: "matched", reference: toRef(reportEvent) });
		fixture2.cleanup();
		fixture.cleanup();
	});

	it("selects event with recordedAt equal to deadline, rejects event after deadline", async () => {
		let now = 1000;
		const fixture = await createAdmissionHarness({ clock: () => now });
		const { coordinator, fence } = fixture;

		const exactEvent = coordinator.seedEvent("exact-deadline", "body");
		const lateEvent = coordinator.seedEvent("late-event", "body");

		const waitExact = coordinator.wait({
			operationId: "wait-exact",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "job", attemptId: "job-exact" },
			deadline: 2000,
		});

		coordinator.coordination.record({
			reference: exactEvent,
			recordedAt: 2000,
			match: { kind: "job", attemptId: "job-exact" },
		});

		coordinator.coordination.finishDue();
		await expect(waitExact).resolves.toEqual({
			waitId: "wait-exact",
			status: "matched",
			reference: toRef(exactEvent),
		});

		now = 3000;
		const waitLate = coordinator.wait({
			operationId: "wait-late",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "job", attemptId: "job-late" },
			deadline: 2500,
		});

		coordinator.coordination.record({
			reference: lateEvent,
			recordedAt: 2501,
			match: { kind: "job", attemptId: "job-late" },
		});

		coordinator.coordination.finishDue();
		await expect(waitLate).resolves.toEqual({ waitId: "wait-late", status: "timeout", deadline: 2500 });
	});

	it("cancels lower-epoch wait with recorded interruption", async () => {
		const fixture = await createAdmissionHarness();
		const { coordinator, fence } = fixture;
		const now = Date.now();

		const wait = coordinator.wait({
			operationId: "wait-to-cancel",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "job", attemptId: "job-c" },
			deadline: now + 1000,
		});

		await coordinator.cancelPermissions({
			operationId: "cancel-op-1",
			scope: { fence, permissionEpoch: 0 },
			nextPermissionEpoch: 1,
		});

		await expect(wait).resolves.toEqual({
			waitId: "wait-to-cancel",
			status: "interrupted",
			reason: "cancelled",
		});
	});

	it("match wins over later cancellation", async () => {
		const fixture = await createAdmissionHarness();
		const { coordinator, fence } = fixture;
		const now = Date.now();

		const event = coordinator.seedEvent("job-match-first", "body");
		coordinator.coordination.record({
			reference: event,
			recordedAt: now,
			match: { kind: "job", attemptId: "job-mf" },
		});

		const wait = await coordinator.wait({
			operationId: "wait-mf",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "job", attemptId: "job-mf" },
			deadline: now + 1000,
		});
		expect(wait).toEqual({ waitId: "wait-mf", status: "matched", reference: toRef(event) });

		await coordinator.cancelPermissions({
			operationId: "cancel-op-2",
			scope: { fence, permissionEpoch: 0 },
			nextPermissionEpoch: 1,
		});

		// Stored wait result does not rewrite to interrupted
		expect(coordinator.coordination.inspectWait("wait-mf")?.result?.status).toBe("matched");
	});

	it("unanswerable reply wait on parent closure or answer deadline", async () => {
		const fixture = await createAdmissionHarness();
		const { coordinator, fence } = fixture;
		const now = Date.now();

		coordinator.coordination.registerQuestion("q-closed", fence.mailboxId, "parent", now + 1000);

		const wait = coordinator.wait({
			operationId: "wait-unans",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "reply", questionId: "q-closed", addressedIdentity: "parent" },
			deadline: now + 500,
		});

		coordinator.coordination.makeUnanswerable("q-closed", "parent-closed");
		await expect(wait).resolves.toEqual({
			waitId: "wait-unans",
			status: "unanswerable",
			reason: "parent-closed",
		});
	});

	it("grants arm or eligible, coalesces duplicates, and refuses consumed re-arm", async () => {
		const fixture = await createAdmissionHarness();
		const { coordinator, fence } = fixture;
		const now = Date.now();

		// Armed grant
		const g1 = await coordinator.grant({
			operationId: "grant-1",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "job", attemptId: "job-arm" },
		});
		expect(g1.state).toBe("armed");

		// Duplicate grant shares receipt
		const g1dup = await coordinator.grant({
			operationId: "grant-1-dup",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "job", attemptId: "job-arm" },
		});
		expect(g1dup.grantId).toBe(g1.grantId);

		// Record event makes it eligible
		const event = coordinator.seedEvent("job-arm-event", "body");
		coordinator.coordination.record({
			reference: event,
			recordedAt: now,
			match: { kind: "job", attemptId: "job-arm" },
		});
		expect(coordinator.coordination.inspectGrant(g1.grantId)?.state).toBe("eligible");

		// Mark consumed
		coordinator.coordination.markConsumed(fence.mailboxId, fence.instanceId, {
			kind: "job",
			attemptId: "job-arm",
		});

		// Consumed target returns consumed
		const gConsumed = await coordinator.grant({
			operationId: "grant-rearm",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "job", attemptId: "job-arm" },
		});
		expect(gConsumed.state).toBe("consumed");
	});

	it("refuses unsupported wake target kinds", async () => {
		const fixture = await createAdmissionHarness();
		const { coordinator, fence } = fixture;

		await expect(
			coordinator.grant({
				operationId: "grant-invalid",
				scope: { fence, permissionEpoch: 0 },
				target: { kind: "attempt" as any, attemptId: "x" },
			}),
		).rejects.toThrow("Unsupported wake target");
	});

	it("validates revocation-only permissions cancellation against old scope vs current scope", async () => {
		const fixture = await createAdmissionHarness();
		const { coordinator, fence } = fixture;

		// Bad token throws
		await expect(
			coordinator.cancelPermissions({
				operationId: "cancel-bad-token",
				scope: { fence: { ...fence, generationToken: "forged" }, permissionEpoch: 0 },
				nextPermissionEpoch: 1,
			}),
		).rejects.toThrow("stale or forged generation token");

		// Future epoch throws
		await expect(
			coordinator.cancelPermissions({
				operationId: "cancel-future-epoch",
				scope: { fence: { ...fence, epoch: fence.epoch + 10 }, permissionEpoch: 0 },
				nextPermissionEpoch: 1,
			}),
		).rejects.toThrow("future runtime epoch");

		// Successor instance is a no-op (canRevoke returns false)
		await coordinator.cancelPermissions({
			operationId: "cancel-successor",
			scope: { fence: { ...fence, instanceId: "old-instance" }, permissionEpoch: 0 },
			nextPermissionEpoch: 1,
		});
		// No error thrown
	});

	it("enforces permission epoch floor: late grant rejected after cancellation on same fence", async () => {
		const fixture = await createAdmissionHarness();
		const { coordinator, fence } = fixture;

		await coordinator.cancelPermissions({
			operationId: "cancel-floor-1",
			scope: { fence, permissionEpoch: 0 },
			nextPermissionEpoch: 1,
		});

		// Late grant with old epoch 0 is rejected
		await expect(
			coordinator.grant({
				operationId: "grant-late-epoch",
				scope: { fence, permissionEpoch: 0 },
				target: { kind: "job", attemptId: "job-late" },
			}),
		).rejects.toThrow("Stale permission epoch");

		// Fresh grant with new epoch 1 succeeds
		const freshGrant = await coordinator.grant({
			operationId: "grant-fresh-epoch",
			scope: { fence, permissionEpoch: 1 },
			target: { kind: "job", attemptId: "job-late" },
		});
		expect(freshGrant.state).toBe("armed");
	});

	it("rejects conflicting grant arguments on same operationId", async () => {
		const fixture = await createAdmissionHarness();
		const { coordinator, fence } = fixture;

		await coordinator.grant({
			operationId: "grant-conflict-op",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "job", attemptId: "job-orig" },
		});

		await expect(
			coordinator.grant({
				operationId: "grant-conflict-op",
				scope: { fence, permissionEpoch: 0 },
				target: { kind: "job", attemptId: "job-changed" },
			}),
		).rejects.toThrow("Conflicting grant operation arguments");
	});

	it("recovery image contains no raw fence tokens and restores committed wait outcomes", async () => {
		const fixture = await createAdmissionHarness();
		const { coordinator, fence } = fixture;
		const now = Date.now();

		const event = coordinator.seedEvent("match-rec", "body");
		coordinator.coordination.record({
			reference: event,
			recordedAt: now,
			match: { kind: "job", attemptId: "job-rec" },
		});

		await coordinator.wait({
			operationId: "wait-rec-1",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "job", attemptId: "job-rec" },
			deadline: now + 1000,
		});

		const image = coordinator.exportRecoveryImage();
		const serialized = JSON.stringify(image);
		expect(serialized).not.toContain(fence.generationToken);

		// Reconstruct new state from recovery image
		const recovered = new FakeCoordinationState(
			() => now,
			() => false, // Event is now read / ineligible
			() => true,
			() => ({ recipientIdentity: "r", eventId: "e" }),
			image.coordination,
		);

		// Retrying the same wait returns original committed matched result
		const retried = await recovered.wait({
			operationId: "wait-rec-1",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "job", attemptId: "job-rec" },
			deadline: now + 1000,
		});
		expect(retried).toEqual({ waitId: "wait-rec-1", status: "matched", reference: toRef(event) });
	});

	it("retrying matched wait after cancellation returns original committed outcome", async () => {
		const fixture = await createAdmissionHarness();
		const { coordinator, fence } = fixture;
		const now = Date.now();

		const event = coordinator.seedEvent("match-retry-cancel", "body");
		coordinator.coordination.record({
			reference: event,
			recordedAt: now,
			match: { kind: "job", attemptId: "job-mrc" },
		});

		const matched = await coordinator.wait({
			operationId: "wait-mrc",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "job", attemptId: "job-mrc" },
			deadline: now + 1000,
		});
		expect(matched.status).toBe("matched");

		// Cancel permissions advances floor
		await coordinator.cancelPermissions({
			operationId: "cancel-mrc",
			scope: { fence, permissionEpoch: 0 },
			nextPermissionEpoch: 1,
		});

		// Same wait operation ID unchanged still returns original matched result
		const retried = await coordinator.wait({
			operationId: "wait-mrc",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "job", attemptId: "job-mrc" },
			deadline: now + 1000,
		});
		expect(retried).toEqual(matched);
	});

	it("rejects admission claim when grant permission epoch or runtime epoch does not match claim", async () => {
		const fixture = await createAdmissionHarness();
		const { coordinator, fence, manager } = fixture;

		const target = coordinator.seedEvent("job-scope-target", "body");
		const grant = await coordinator.grant({
			operationId: "grant-scope-epoch",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "job", attemptId: "job-scope" },
		});
		coordinator.coordination.record({
			reference: target,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-scope" },
		});

		const receipt = manager.appendEntryOnce(target, null);
		const conversation = fixture.runtimeCoordinator.attachmentFor(fence.mailboxId)!.conversation;
		await coordinator.delivered(
			{
				requestId: "req-scope",
				conversation,
				fence,
				branchAnchor: null,
				references: [target],
			},
			[receipt],
		);

		// Claim stamped with permissionEpoch 1 (grant was epoch 0) -> no matching grant in exact scope -> unavailable
		const commitResult = await coordinator.admit({
			request: {
				requestId: "req-scope",
				conversation,
				fence,
				branchAnchor: null,
				references: [target],
				activation: {
					claimId: "claim-mismatch",
					instanceId: fence.instanceId,
					runtimeEpoch: fence.epoch,
					permissionEpoch: 1,
					targets: [{ grantId: grant.grantId, event: target }],
				},
			},
			selected: [{ entryId: "entry-scope", event: target, receipt, envelope: "env" }],
			dispositions: [],
		});

		// Zero entries admitted because grant was epoch 0, not epoch 1
		expect(commitResult.entries).toHaveLength(0);
		expect(commitResult.dispositions[0]?.code).toBe("unavailable");
	});

	it("late reply arrival with no timer tick does not match question whose answer deadline passed", async () => {
		let now = 1000;
		const fixture = await createAdmissionHarness({ clock: () => now });
		const { coordinator, fence } = fixture;

		coordinator.coordination.registerQuestion("q-late-arrival", fence.mailboxId, "parent", 2000);

		const reply = coordinator.seedEvent("reply-late-arrival", "body");

		// Advance clock past question answer deadline without calling finishDue
		now = 2500;

		// Record reply arriving after question answer deadline
		coordinator.coordination.record({
			reference: reply,
			recordedAt: 2500,
			match: { kind: "reply", questionId: "q-late-arrival", senderIdentity: "parent" },
		});

		// Wait registered after question deadline elapsed is unanswerable immediately
		const wait = await coordinator.wait({
			operationId: "wait-late-arr",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "reply", questionId: "q-late-arrival", addressedIdentity: "parent" },
			deadline: 5000,
		});
		expect(wait.status).toBe("unanswerable");

		// Duplicate grant after answer expiry returns revoked
		const grant = await coordinator.grant({
			operationId: "grant-late-arr",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "reply", questionId: "q-late-arrival", addressedIdentity: "parent" },
		});
		expect(grant.state).toBe("revoked");
	});

	it("terminates reply wait immediately when answer deadline elapsed or parent closed before registration", async () => {
		let now = 1000;
		const fixture = await createAdmissionHarness({ clock: () => now });
		const { coordinator, fence } = fixture;

		// Question answer deadline at 2000, wait deadline at 5000
		coordinator.coordination.registerQuestion("q-early-deadline", fence.mailboxId, "parent", 2000);

		now = 2500;
		const wait = await coordinator.wait({
			operationId: "wait-early-q-deadline",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "reply", questionId: "q-early-deadline", addressedIdentity: "parent" },
			deadline: 5000,
		});
		expect(wait).toEqual({
			waitId: "wait-early-q-deadline",
			status: "unanswerable",
			reason: "answer-deadline",
		});

		// Grant on expired question is revoked
		const grant = await coordinator.grant({
			operationId: "grant-expired-q",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "reply", questionId: "q-early-deadline", addressedIdentity: "parent" },
		});
		expect(grant.state).toBe("revoked");
	});

	it("handles idle subscriptions: already-idle, detach reason, coalescing, and expiry", async () => {
		let now = 1000;
		const fixture = await createAdmissionHarness({ clock: () => now });
		const { coordinator, fence } = fixture;

		// Already idle satisfies immediately
		const sub1 = coordinator.coordination.registerIdleSubscription({
			requesterMailbox: fence.mailboxId,
			watchedInstanceId: "watched-1",
			expiresAt: 5000,
			observed: "idle",
		});
		expect(sub1.result.status).toBe("satisfied");
		if (sub1.result.status === "satisfied") {
			expect(sub1.result.reason).toBe("idle");
		}

		// Coalesces duplicate pending subscription
		const sub2 = coordinator.coordination.registerIdleSubscription({
			requesterMailbox: fence.mailboxId,
			watchedInstanceId: "watched-2",
			expiresAt: 5000,
			observed: "busy",
		});
		expect(sub2.result.status).toBe("pending");

		const sub2dup = coordinator.coordination.registerIdleSubscription({
			requesterMailbox: fence.mailboxId,
			watchedInstanceId: "watched-2",
			expiresAt: 6000,
			observed: "busy",
		});
		expect(sub2dup.subscriptionId).toBe(sub2.subscriptionId);

		// Satisfy with runtime-detached
		coordinator.coordination.satisfyIdleSubscriptions("watched-2", "runtime-detached");
		const inspectedSub2 = coordinator.coordination.inspectSubscription(sub2.subscriptionId);
		expect(inspectedSub2?.result.status).toBe("satisfied");
		if (inspectedSub2?.result.status === "satisfied") {
			expect(inspectedSub2.result.reason).toBe("runtime-detached");
		}

		// Subscription expires when past expiresAt
		const sub3 = coordinator.coordination.registerIdleSubscription({
			requesterMailbox: fence.mailboxId,
			watchedInstanceId: "watched-3",
			expiresAt: 2000,
			observed: "busy",
		});
		now = 2500;
		coordinator.coordination.finishDue();
		expect(coordinator.coordination.inspectSubscription(sub3.subscriptionId)?.result.status).toBe("expired");
	});

	it("atomically consumes grant during held admission commit and exports recovery image", async () => {
		const fixture = await createAdmissionHarness();
		const { coordinator, fence, manager } = fixture;

		const targetEvent = coordinator.seedEvent("target-ev", "body");
		const grant = await coordinator.grant({
			operationId: "grant-atom",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "job", attemptId: "job-atom" },
		});
		coordinator.coordination.record({
			reference: targetEvent,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-atom" },
		});

		expect(coordinator.coordination.inspectGrant(grant.grantId)?.state).toBe("eligible");

		const conversation = fixture.runtimeCoordinator.attachmentFor(fence.mailboxId)!.conversation;

		const receipt = manager.appendEntryOnce(targetEvent, null);
		await coordinator.delivered(
			{
				requestId: "req-1",
				conversation,
				fence,
				branchAnchor: null,
				references: [targetEvent],
			},
			[receipt],
		);

		// Hold admission commit
		const gate = coordinator.holdNextAdmission();
		const admitPromise = coordinator.admit({
			request: {
				requestId: "req-1",
				conversation,
				fence,
				branchAnchor: null,
				references: [targetEvent],
				activation: {
					claimId: "claim-1",
					instanceId: fence.instanceId,
					runtimeEpoch: fence.epoch,
					permissionEpoch: 0,
					targets: [{ grantId: grant.grantId, event: targetEvent }],
				},
			},
			selected: [
				{
					entryId: "entry-admit-1",
					event: targetEvent,
					receipt,
					envelope: "target envelope",
				},
			],
			dispositions: [],
		});

		await gate.received;
		expect(coordinator.inspectEvent(targetEvent)?.state).toBe("pending");
		expect(coordinator.coordination.inspectGrant(grant.grantId)?.state).toBe("eligible");

		gate.commit();
		await gate.committed;
		expect(coordinator.inspectEvent(targetEvent)?.state).toBe("read");
		expect(coordinator.coordination.inspectGrant(grant.grantId)?.state).toBe("consumed");

		gate.respond();
		const commitResult = await admitPromise;
		expect(commitResult.entries).toHaveLength(1);

		// Recovery image has both
		const image = coordinator.exportRecoveryImage();
		expect(image.coordination?.consumedTargets.some((t) => t.includes("job-atom"))).toBe(true);
	});

	it("returns disposition-only commit when target expires but unrelated mail fits", async () => {
		let now = 1000;
		const fixture = await createAdmissionHarness({ clock: () => now });
		const { coordinator, fence, manager } = fixture;

		const targetEvent = coordinator.seedEvent("target-exp", "body", 1500);
		const unrelatedMail = coordinator.seedEvent("unrelated-mail", "body");

		const grant = await coordinator.grant({
			operationId: "grant-exp",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "job", attemptId: "job-exp" },
		});
		coordinator.coordination.record({
			reference: targetEvent,
			recordedAt: now,
			match: { kind: "job", attemptId: "job-exp" },
		});

		const receiptTarget = manager.appendEntryOnce(targetEvent, null);
		const receiptMail = manager.appendEntryOnce(unrelatedMail, null);

		const conversation = fixture.runtimeCoordinator.attachmentFor(fence.mailboxId)!.conversation;

		await coordinator.delivered(
			{
				requestId: "req-exp",
				conversation,
				fence,
				branchAnchor: null,
				references: [targetEvent, unrelatedMail],
			},
			[receiptTarget, receiptMail],
		);

		// Advance clock past target expiration
		now = 2000;

		const commitResult = await coordinator.admit({
			request: {
				requestId: "req-exp",
				conversation,
				fence,
				branchAnchor: null,
				references: [targetEvent, unrelatedMail],
				activation: {
					claimId: "claim-exp",
					instanceId: fence.instanceId,
					runtimeEpoch: fence.epoch,
					permissionEpoch: 0,
					targets: [{ grantId: grant.grantId, event: targetEvent }],
				},
			},
			selected: [
				{ entryId: "entry-adm-t", event: targetEvent, receipt: receiptTarget, envelope: "env-t" },
				{ entryId: "entry-adm-m", event: unrelatedMail, receipt: receiptMail, envelope: "env-m" },
			],
			dispositions: [],
		});

		// Committed result has zero entries, target-expired and mail-unavailable dispositions
		expect(commitResult.entries).toHaveLength(0);
		expect(commitResult.dispositions).toEqual([
			{
				recipientIdentity: targetEvent.recipientIdentity,
				eventId: targetEvent.eventId,
				code: "expired",
				reason: "expired",
			},
			{
				recipientIdentity: unrelatedMail.recipientIdentity,
				eventId: unrelatedMail.eventId,
				code: "unavailable",
				reason: "Wake target unavailable; event retained for an authorized request",
			},
		]);
		// Unrelated mail remains pending (not read)
		expect(coordinator.inspectEvent(unrelatedMail)?.state).toBe("pending");
		// Grant was not consumed
		expect(coordinator.coordination.inspectGrant(grant.grantId)?.state).toBe("eligible");
	});
});
