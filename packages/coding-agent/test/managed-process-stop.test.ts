import { expect, test } from "vitest";
import { type ManagedCallContext, withManagedCall } from "../src/core/managed-process-context.ts";
import type { StopReceipt } from "../src/core/managed-process-types.ts";
import type { RuntimeFence } from "../src/core/runtime-lifecycle-types.ts";
import { type BatchCertificate, conversationKeyOf, type FinalizationBinding } from "../src/core/task-finalization.ts";
import { deferred, fixture, offlineOwner } from "./helpers/managed-process.ts";

/** Binds the attempt of `context` as an inline run, the way the claimed run's attempt is bound. */
function bindInline(f: ReturnType<typeof fixture>, context: ManagedCallContext, runId: string): FinalizationBinding {
	const binding: FinalizationBinding = {
		attemptId: context.attempt.intent.attemptId,
		runId,
		conversationKey: conversationKeyOf(context.attempt.intent.provenance.conversation),
		kind: "inline",
	};
	f.taskFinalizations.bind(binding);
	return binding;
}

const receipt = (attemptId: string, phase: StopReceipt["phase"]): StopReceipt => ({
	operationId: `receipt-${attemptId}-${phase}`,
	attemptId,
	stopId: "stop-one",
	phase,
	registryThrough: 9,
});

test("a service stop latches task finalization before any cancellation or abort callback runs", async () => {
	const events: string[] = [];
	const f = fixture();
	const context = f.begin("target", "instance-one", "run-one");
	const binding = bindInline(f, context, "run-one");
	const latched = () => f.taskFinalizations.blocks(binding.conversationKey, binding);
	context.attempt.gates.add(() => events.push(`gate:${latched()}`));
	context.attempt.cancellations.add(() => events.push(`cancel:${latched()}`));
	const owner = offlineOwner(f, context, {
		abortRun: async () => {
			events.push(`abort:${latched()}`);
		},
	});
	owner.facade.bind(f.adapter);
	expect(latched()).toBe(false);
	const ack = owner.facade.requestStop("target", "stop-one");
	expect(ack.requested).toBe(true);
	// Synchronous: the latch is set before requestStop returns, not when the abort callback runs.
	expect(latched()).toBe(true);
	await ack.settled;
	expect(events).toEqual(["gate:true", "cancel:true", "abort:true"]);
});

test("the latch does not depend on the abort callback succeeding", async () => {
	const f = fixture();
	const context = f.begin("target", "instance-one", "run-one");
	const binding = bindInline(f, context, "run-one");
	const owner = offlineOwner(f, context, {
		abortRun: async () => {
			throw new Error("abort failed");
		},
	});
	owner.facade.bind(f.adapter);
	await expect(owner.facade.requestStop("target", "stop-one").settled).rejects.toThrow(/abort failed/);
	expect(f.taskFinalizations.blocks(binding.conversationKey, binding)).toBe(true);
});

test("later stop controls for a stopping attempt share its settled promise without another abort, even on synchronous reentry", async () => {
	const f = fixture();
	const context = f.begin("target", "instance-one", "run-one");
	bindInline(f, context, "run-one");
	const release = deferred<void>();
	let aborts = 0;
	let cancellations = 0;
	let reentrant: Promise<void> | undefined;
	const owner = offlineOwner(f, context, {
		abortRun: async () => {
			aborts++;
			await release.promise;
		},
	});
	owner.facade.bind(f.adapter);
	context.attempt.gates.add(() => {
		cancellations++;
		reentrant = owner.facade.requestStop("target", "reentrant-confirmed").settled;
	});
	const first = owner.facade.requestStop("target", "first-uncertain");
	const same = owner.facade.requestStop("target", "first-uncertain");
	const next = owner.facade.requestStop("target", "second-confirmed");
	expect(reentrant).toBe(first.settled);
	expect(same.settled).toBe(first.settled);
	expect(next.settled).toBe(first.settled);
	expect(cancellations).toBe(1);
	await Promise.resolve();
	expect(aborts).toBe(1);
	release.resolve();
	await first.settled;
	const after = owner.facade.requestStop("target", "after-settled");
	expect(after.settled).toBe(first.settled);
	await after.settled;
	expect(aborts).toBe(1);
	expect(context.attempt.ended).toBe(true);
});

test("a stop for another runtime's attempt, or an unknown one, latches nothing", () => {
	const f = fixture();
	const foreign = f.begin("foreign", "instance-two", "run-foreign");
	const binding = bindInline(f, foreign, "run-foreign");
	const owner = offlineOwner(f, f.begin("mine"));
	owner.facade.bind(f.adapter);
	expect(() => owner.facade.requestStop("foreign", "stop-one")).toThrow(/another runtime/);
	expect(() => owner.facade.requestStop("unknown", "stop-one")).toThrow(/another runtime/);
	expect(f.taskFinalizations.blocks(binding.conversationKey, binding)).toBe(false);
	expect(foreign.attempt.stopping).toBe(false);
});

test("stop receipts carry the attempt's original launch fence, also for an earlier runtime's attempt", async () => {
	const sent: { receipt: StopReceipt; fence: RuntimeFence }[] = [];
	const f = fixture({
		abortReceipt: async (input, fence) => {
			sent.push({ receipt: input, fence });
		},
	});
	const mine = f.begin("mine");
	const earlier = f.begin("earlier", "instance-two");
	const owner = offlineOwner(f, mine);
	owner.facade.bind(f.adapter);
	await owner.facade.acknowledgeStop(receipt("mine", "requested"));
	await owner.facade.acknowledgeStop(receipt("earlier", "settled"));
	expect(sent.map((item) => item.receipt.attemptId)).toEqual(["mine", "earlier"]);
	expect(sent[0].fence).toBe(mine.attempt.fence);
	expect(sent[1].fence).toBe(earlier.attempt.fence);
	expect(sent[1].fence.instanceId).toBe("instance-two");
});

test("a stop receipt without original provenance is refused", async () => {
	const sent: StopReceipt[] = [];
	const f = fixture({
		abortReceipt: async (input) => {
			sent.push(input);
		},
	});
	const mine = f.begin("mine");
	f.registry.begin(
		{
			operationId: "open-unfenced",
			attemptId: "unfenced",
			marker: "marker-unfenced",
			runId: null,
			provenance: mine.attempt.intent.provenance,
		},
		undefined,
		f.adapter,
	);
	const owner = offlineOwner(f, mine);
	owner.facade.bind(f.adapter);
	await expect(owner.facade.acknowledgeStop(receipt("unknown", "requested"))).rejects.toThrow(/provenance/);
	await expect(owner.facade.acknowledgeStop(receipt("unfenced", "requested"))).rejects.toThrow(/provenance/);
	await expect(offlineOwner(f, mine).facade.acknowledgeStop(receipt("mine", "requested"))).rejects.toThrow(
		/provenance/,
	);
	expect(sent).toEqual([]);
});

test("declaring finalization needs the active managed tool call of the bound run and stages once", () => {
	const f = fixture();
	const context = f.begin("target", "instance-one", "run-one");
	const owner = offlineOwner(f, context);
	owner.facade.bind(f.adapter);
	const declaration = {
		operationId: "declare-one",
		claim: "claimed-success" as const,
		declarationToolCallId: context.toolCallId,
	};
	const declare = (input = declaration) => withManagedCall(context, () => owner.facade.declareTaskFinalization(input));
	expect(() => owner.facade.declareTaskFinalization(declaration)).toThrow(/active managed tool call/);
	expect(() => declare()).toThrow(/another run/);
	bindInline(f, context, "run-one");
	expect(() => declare({ ...declaration, declarationToolCallId: "other-call" })).toThrow(/active managed tool call/);
	declare();
	expect(() => declare({ ...declaration, operationId: "declare-two" })).toThrow(/already staged/);
});

test("a finalization certificate is frozen at its covering image and retried with identical bytes", async () => {
	const sent: BatchCertificate[] = [];
	let lose = true;
	const f = fixture({
		finalize: async (certificate) => {
			sent.push(certificate);
			if (lose) {
				lose = false;
				throw new Error("response lost");
			}
			return "committed";
		},
	});
	const context = f.begin("target", "instance-one", "run-one");
	let through = 10;
	const owner = offlineOwner(f, context, {
		reconcileProcessAttempt: async (_adapter, target) => ({ ...target, through: through++ }),
	});
	owner.facade.bind(f.adapter);
	const certificate: BatchCertificate = {
		operationId: "final-one",
		attemptId: "target",
		runId: "run-one",
		registryThrough: 0,
		claim: "claimed-success",
		declarationToolCallId: "tool-one",
		toolResults: [{ toolCallId: "tool-one", isError: false }],
		declarationBeforeResults: false,
	};
	await expect(owner.commitFinalization(certificate)).rejects.toThrow(/original ended agent run/);
	f.registry.end(context.attempt);
	await expect(owner.commitFinalization({ ...certificate, runId: "other-run" })).rejects.toThrow(
		/original ended agent run/,
	);
	await expect(owner.commitFinalization(certificate)).rejects.toThrow(/response lost/);
	await expect(owner.commitFinalization(certificate)).resolves.toBe("committed");
	expect(sent).toHaveLength(2);
	expect(sent[1]).toBe(sent[0]);
	expect(Object.isFrozen(sent[0])).toBe(true);
	expect(Object.isFrozen(sent[0].toolResults)).toBe(true);
	// The covering image's through, drained once, replaces the draft value.
	expect(sent[0].registryThrough).toBe(10);
	expect(through).toBe(11);
	await expect(owner.commitFinalization({ ...certificate, operationId: "final-two" })).rejects.toThrow(/changed/);
});

test("a pending certificate is delivered once and kept until the service answers", async () => {
	let fail = true;
	const sent: BatchCertificate[] = [];
	const f = fixture({
		finalize: async (certificate) => {
			sent.push(certificate);
			if (fail) throw new Error("service unavailable");
			return "committed";
		},
	});
	const context = f.begin("target", "instance-one", "run-one");
	const binding = bindInline(f, context, "run-one");
	const owner = offlineOwner(f, context);
	owner.facade.bind(f.adapter);
	f.taskFinalizations.stage(binding, {
		operationId: "final-one",
		claim: "claimed-success",
		declarationToolCallId: "tool-one",
	});
	expect(
		f.taskFinalizations.boundary(binding, {
			aborted: false,
			registryThrough: 5,
			toolResults: [{ toolCallId: "tool-one", isError: false }],
		}),
	).toBe(true);
	f.registry.end(context.attempt);
	await expect(owner.facade.reconcileFinalizations()).rejects.toThrow(/service unavailable/);
	expect(f.taskFinalizations.pending("target")).toBeDefined();
	fail = false;
	await owner.facade.reconcileFinalizations();
	expect(f.taskFinalizations.pending("target")).toBeUndefined();
	await owner.facade.reconcileFinalizations();
	expect(sent).toHaveLength(2);
	expect(sent[1]).toBe(sent[0]);
});
