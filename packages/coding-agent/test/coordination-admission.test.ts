import { normalizeContext } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { CoordinationAdmissionPolicy, WakeClaim } from "../src/core/coordination-scheduler-types.ts";
import { CANDIDATE_MESSAGE } from "../src/core/durable-records.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { RequestAdmissionOwner } from "../src/core/request-admission.ts";
import { createAdmissionHarness } from "./helpers/request-admission.ts";

function claimedOwner(
	fixture: Awaited<ReturnType<typeof createAdmissionHarness>>,
	activation: WakeClaim,
	reserveTokens = () => 1024,
) {
	const { harness, manager, coordinator } = fixture;
	const policy: CoordinationAdmissionPolicy = {
		capture: () => activation,
		beforeFinalize: async () => {},
		assertCurrent: () => {
			if (!harness.session.runtimeLifecycle.isCurrent(fixture.fence)) throw new Error("stale test scope");
		},
		committed: vi.fn(),
		assistantStarted: vi.fn(),
		blocked: vi.fn(),
	};
	const owner = new RequestAdmissionOwner(
		harness.session.runtimeLifecycle,
		manager,
		() => true,
		() => !harness.session.isDisposed,
		() => {},
		reserveTokens,
		() => {},
		() => {},
		async (request, _reservation, assertCurrent) => {
			assertCurrent();
			return { context: request.context };
		},
		() => {},
		policy,
	);
	const unbind = owner.bind(coordinator);
	return { owner, policy, unbind };
}

describe("coordination admission owner policy validation", () => {
	it("rejects when target is removed whole from candidate context", async () => {
		const fixture = await createAdmissionHarness();
		const { coordinator, fence, harness } = fixture;

		const target = coordinator.seedEvent("job-target-1", "TARGET_BODY");
		const grant = await coordinator.grant({
			operationId: "grant-1",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "job", attemptId: "job-1" },
		});
		coordinator.coordination.record({
			reference: target,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-1" },
		});

		const activation: WakeClaim = {
			claimId: "claim-1",
			instanceId: fence.instanceId,
			runtimeEpoch: fence.epoch,
			permissionEpoch: 0,
			targets: [{ grantId: grant.grantId, event: target }],
		};

		const { owner, policy, unbind } = claimedOwner(fixture, activation);
		const model = harness.session.model;
		if (!model) throw new Error("missing model");

		try {
			const prepared = await owner.prepare({
				context: { messages: [...harness.session.messages] },
				model,
				thinkingLevel: harness.session.thinkingLevel,
			});
			if (!prepared || !prepared.context) throw new Error("expected prepared update");

			// Remove candidate message whole
			const filteredMessages = prepared.context.messages.filter(
				(m) => !(m.role === "custom" && m.customType === CANDIDATE_MESSAGE),
			);

			await expect(
				owner.finalize({
					messages: filteredMessages,
					context: normalizeContext({ messages: convertToLlm(filteredMessages) }),
					model,
					thinkingLevel: harness.session.thinkingLevel,
				}),
			).rejects.toThrow("Wake target is not admissible");

			expect(policy.blocked).toHaveBeenCalledTimes(1);
			expect(policy.blocked).toHaveBeenCalledWith(activation, "wake-blocked");
		} finally {
			unbind();
			fixture.cleanup();
		}
	});

	it("rejects when candidate is corrupted in context", async () => {
		const fixture = await createAdmissionHarness();
		const { coordinator, fence, harness } = fixture;

		const target = coordinator.seedEvent("job-target-corrupt", "TARGET_BODY");
		const grant = await coordinator.grant({
			operationId: "grant-corrupt",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "job", attemptId: "job-corrupt" },
		});
		coordinator.coordination.record({
			reference: target,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-corrupt" },
		});

		const activation: WakeClaim = {
			claimId: "claim-corrupt",
			instanceId: fence.instanceId,
			runtimeEpoch: fence.epoch,
			permissionEpoch: 0,
			targets: [{ grantId: grant.grantId, event: target }],
		};

		const { owner, policy, unbind } = claimedOwner(fixture, activation);
		const model = harness.session.model;
		if (!model) throw new Error("missing model");

		try {
			const prepared = await owner.prepare({
				context: { messages: [...harness.session.messages] },
				model,
				thinkingLevel: harness.session.thinkingLevel,
			});
			if (!prepared || !prepared.context) throw new Error("expected prepared update");

			// Corrupt the candidate message
			const corruptedMessages = prepared.context.messages.map((m) =>
				m.role === "custom" && m.customType === CANDIDATE_MESSAGE ? { ...m, content: "corrupted content" } : m,
			);

			await expect(
				owner.finalize({
					messages: corruptedMessages,
					context: normalizeContext({ messages: convertToLlm(corruptedMessages) }),
					model,
					thinkingLevel: harness.session.thinkingLevel,
				}),
			).rejects.toThrow("Candidate identity or content changed");

			expect(policy.blocked).toHaveBeenCalledTimes(1);
			expect(policy.blocked).toHaveBeenCalledWith(activation, "candidate-corrupt");
		} finally {
			unbind();
			fixture.cleanup();
		}
	});

	it("rejects when disposition exceeds capacity budget", async () => {
		const fixture = await createAdmissionHarness();
		const { coordinator, fence, harness } = fixture;

		const target = coordinator.seedEvent("job-target-budget", "TARGET_BODY");
		const grant = await coordinator.grant({
			operationId: "grant-budget",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "job", attemptId: "job-budget" },
		});
		coordinator.coordination.record({
			reference: target,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-budget" },
		});

		const activation: WakeClaim = {
			claimId: "claim-budget",
			instanceId: fence.instanceId,
			runtimeEpoch: fence.epoch,
			permissionEpoch: 0,
			targets: [{ grantId: grant.grantId, event: target }],
		};

		// Force zero capacity budget
		const { owner, policy, unbind } = claimedOwner(fixture, activation, () => 100000);
		const model = { ...harness.session.model!, contextWindow: 10 };

		try {
			const prepared = await owner.prepare({
				context: { messages: [...harness.session.messages] },
				model,
				thinkingLevel: harness.session.thinkingLevel,
			});
			if (!prepared || !prepared.context) throw new Error("expected prepared update");

			await expect(
				owner.finalize({
					messages: prepared.context.messages,
					context: normalizeContext({ messages: convertToLlm(prepared.context.messages) }),
					model,
					thinkingLevel: harness.session.thinkingLevel,
				}),
			).rejects.toThrow(/request capacity/);

			expect(policy.blocked).toHaveBeenCalledTimes(1);
			expect(policy.blocked).toHaveBeenCalledWith(activation, "admission-budget");
		} finally {
			unbind();
			fixture.cleanup();
		}
	});

	it("rejects when target expires before held admission commit", async () => {
		let now = Date.now();
		const fixture = await createAdmissionHarness({ clock: () => now });
		const { coordinator, fence, harness } = fixture;

		const target = coordinator.seedEvent("job-target-exp", "TARGET_BODY", now + 10000);
		const grant = await coordinator.grant({
			operationId: "grant-exp",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "job", attemptId: "job-exp" },
		});
		coordinator.coordination.record({
			reference: target,
			recordedAt: now,
			match: { kind: "job", attemptId: "job-exp" },
		});

		const activation: WakeClaim = {
			claimId: "claim-exp",
			instanceId: fence.instanceId,
			runtimeEpoch: fence.epoch,
			permissionEpoch: 0,
			targets: [{ grantId: grant.grantId, event: target }],
		};

		const { owner, policy, unbind } = claimedOwner(fixture, activation);
		const model = harness.session.model;
		if (!model) throw new Error("missing model");

		try {
			const prepared = await owner.prepare({
				context: { messages: [...harness.session.messages] },
				model,
				thinkingLevel: harness.session.thinkingLevel,
			});
			if (!prepared || !prepared.context) throw new Error("expected prepared update");

			// Hold admission so target expires after prepare but before commit
			const gate = coordinator.holdNextAdmission();
			const finalizePromise = owner.finalize({
				messages: prepared.context.messages,
				context: normalizeContext({ messages: convertToLlm(prepared.context.messages) }),
				model,
				thinkingLevel: harness.session.thinkingLevel,
			});

			await gate.received;
			now += 20000;
			gate.commit();
			await gate.committed;
			gate.respond();

			await expect(finalizePromise).rejects.toThrow("Wake target was unavailable at admission");

			expect(policy.blocked).toHaveBeenCalledTimes(1);
			expect(policy.blocked).toHaveBeenCalledWith(activation, "wake-blocked");
		} finally {
			unbind();
			fixture.cleanup();
		}
	});

	it("finalizes positive witness with standalone envelope and notifies committed", async () => {
		const fixture = await createAdmissionHarness();
		const { coordinator, fence, harness } = fixture;

		const target = coordinator.seedEvent("job-target-pos", "TARGET_BODY");
		const grant = await coordinator.grant({
			operationId: "grant-pos",
			scope: { fence, permissionEpoch: 0 },
			target: { kind: "job", attemptId: "job-pos" },
		});
		coordinator.coordination.record({
			reference: target,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-pos" },
		});

		const activation: WakeClaim = {
			claimId: "claim-pos",
			instanceId: fence.instanceId,
			runtimeEpoch: fence.epoch,
			permissionEpoch: 0,
			targets: [{ grantId: grant.grantId, event: target }],
		};

		const { owner, policy, unbind } = claimedOwner(fixture, activation);
		const model = harness.session.model;
		if (!model) throw new Error("missing model");

		try {
			const prepared = await owner.prepare({
				context: { messages: [...harness.session.messages] },
				model,
				thinkingLevel: harness.session.thinkingLevel,
			});
			if (!prepared || !prepared.context) throw new Error("expected prepared update");

			const finalized = await owner.finalize({
				messages: prepared.context.messages,
				context: normalizeContext({ messages: convertToLlm(prepared.context.messages) }),
				model,
				thinkingLevel: harness.session.thinkingLevel,
			});
			if (!finalized) throw new Error("expected finalized request");

			const commit = (policy.committed as any).mock.calls[0][0];
			const stored = coordinator.inspectRequest(commit.requestId);
			if (!stored) throw new Error("missing committed request");
			const envelope = stored.result.entries[0]?.record.envelope;
			if (!envelope) throw new Error("missing admitted envelope");

			// Standalone envelope in finalized context
			const standalone = finalized.context.messages.filter(
				(message) =>
					message.role === "user" &&
					Array.isArray(message.content) &&
					message.content.length === 1 &&
					message.content[0].type === "text" &&
					message.content[0].text === envelope,
			);
			expect(standalone).toHaveLength(1);
			expect(policy.committed).toHaveBeenCalledTimes(1);
			expect(policy.blocked).not.toHaveBeenCalled();

			// Assistant start invokes policy callback
			finalized.onAssistantStart();
			expect(policy.assistantStarted).toHaveBeenCalledTimes(1);
		} finally {
			unbind();
			fixture.cleanup();
		}
	});
});
