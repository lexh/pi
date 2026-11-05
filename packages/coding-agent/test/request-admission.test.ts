import { describe, expect, it } from "vitest";
import type { AdmissionProposal, AdmissionRequest, CanonicalEvent } from "../src/core/request-admission-types.ts";
import { resolveConversationBinding } from "../src/core/runtime-incarnation.ts";
import { FakeRequestCoordinator } from "./helpers/fake-request-coordinator.ts";
import { createAdmissionHarness } from "./helpers/request-admission.ts";

async function proposalFor(
	f: Awaited<ReturnType<typeof createAdmissionHarness>>,
	events: CanonicalEvent[],
	requestId = "request",
): Promise<AdmissionProposal> {
	const request: AdmissionRequest = {
		requestId,
		conversation: resolveConversationBinding(f.manager),
		fence: f.fence,
		branchAnchor: f.manager.getLeafId(),
		references: events.map(({ recipientIdentity, eventId }) => ({ recipientIdentity, eventId })),
	};
	const receipts = events.map((event) => f.manager.appendEntryOnce(event, request.branchAnchor));
	await f.coordinator.delivered(request, receipts);
	return {
		request,
		selected: events.map((event, index) => ({
			event,
			receipt: receipts[index]!,
			entryId: `reserved-${index}`,
			envelope: event.envelope,
		})),
		dispositions: [],
	};
}

describe("authoritative snapshots", () => {
	it("returns ordinary unread mailbox events in seed order with a finite immutable snapshot", async () => {
		const f = await createAdmissionHarness({ clock: () => 1000 });
		try {
			const a = f.coordinator.seedEvent("ordinary-a", "one");
			const b = f.coordinator.seedEvent("ordinary-b", "two");
			const request: AdmissionRequest = {
				requestId: "snapshot",
				conversation: resolveConversationBinding(f.manager),
				fence: f.fence,
				branchAnchor: f.manager.getLeafId(),
				references: [],
			};
			const snapshot = await f.coordinator.snapshot(request);
			expect(a.recipientIdentity).toBe(f.fence.mailboxId);
			expect(snapshot.candidates.map((candidate) => candidate.canonical)).toEqual([a, b]);
			f.coordinator.seedEvent("later", "three");
			expect(snapshot.candidates.map((candidate) => candidate.canonical)).toEqual([a, b]);
			expect(
				(await f.coordinator.snapshot(request)).candidates.map((candidate) => candidate.canonical.eventId),
			).toEqual(["ordinary-a", "ordinary-b", "later"]);
			const receipt = f.manager.appendEntryOnce(a, request.branchAnchor);
			await f.coordinator.delivered(request, [receipt]);
			expect(f.coordinator.inspectEvent(a)).toMatchObject({ state: "pending", deliveredAt: 1000, readAt: null });
			const committed = await f.coordinator.admit({
				request,
				selected: [{ entryId: "ordinary-entry", event: a, receipt, envelope: a.envelope }],
				dispositions: [],
			});
			expect(committed.entries.map((entry) => entry.record.eventId)).toEqual(["ordinary-a"]);
		} finally {
			f.cleanup();
		}
	});
	it("unions references once and reports unavailable, read, expired and dropped without bodies", async () => {
		let now = 1000;
		const f = await createAdmissionHarness({ clock: () => now });
		try {
			const pending = f.coordinator.seedEvent("pending", "pending body");
			const read = f.coordinator.seedEvent("read-ref", "read body");
			const expired = f.coordinator.seedEvent("expired-ref", "expired body", 2000);
			const dropped = f.coordinator.seedEvent("dropped-ref", "dropped body");
			await f.coordinator.admit(await proposalFor(f, [read], "read-first"));
			f.coordinator.dropEvent(dropped);
			now = 2000;
			const unknown = { recipientIdentity: f.fence.mailboxId, eventId: "unknown" };
			const request: AdmissionRequest = {
				requestId: "snapshot",
				conversation: resolveConversationBinding(f.manager),
				fence: f.fence,
				branchAnchor: f.manager.getLeafId(),
				references: [pending, pending, read, expired, dropped, unknown, unknown].map(
					({ recipientIdentity, eventId }) => ({ recipientIdentity, eventId }),
				),
			};
			const result = await f.coordinator.snapshot(request);
			expect(result.candidates.map((candidate) => candidate.canonical.eventId)).toEqual(["pending"]);
			expect(result.dispositions.map(({ eventId, code }) => [eventId, code])).toEqual([
				["read-ref", "already-read"],
				["expired-ref", "expired"],
				["dropped-ref", "dropped"],
				["unknown", "unavailable"],
			]);
			expect(JSON.stringify(result.dispositions)).not.toContain("body");
			expect(f.coordinator.inspectEvent(expired)?.readAt).toBeNull();
			expect(f.coordinator.inspectEvent(dropped)?.readAt).toBeNull();
		} finally {
			f.cleanup();
		}
	});
	it("rejects cross-mailbox delivery and selection, including a mismatched conversation", async () => {
		const f = await createAdmissionHarness({ clock: () => 1000 });
		const other = await createAdmissionHarness({ clock: () => 1000 });
		try {
			const foreign = f.coordinator.seedEvent("foreign", "secret", null, other.fence.mailboxId);
			const request: AdmissionRequest = {
				requestId: "foreign",
				conversation: resolveConversationBinding(f.manager),
				fence: f.fence,
				branchAnchor: f.manager.getLeafId(),
				references: [{ recipientIdentity: foreign.recipientIdentity, eventId: foreign.eventId }],
			};
			const receipt = f.manager.appendEntryOnce(foreign, request.branchAnchor);
			f.coordinator.seedMatchingConsumption(foreign, "foreign-wait");
			const snapshot = await f.coordinator.snapshot(request);
			expect(snapshot.candidates).toEqual([]);
			expect(snapshot.dispositions).toMatchObject([{ eventId: "foreign", code: "unavailable" }]);
			await expect(f.coordinator.delivered(request, [receipt])).rejects.toThrow();
			await expect(
				f.coordinator.admit({
					request,
					selected: [{ entryId: "foreign-entry", event: foreign, receipt, envelope: foreign.envelope }],
					dispositions: [],
				}),
			).rejects.toThrow();
			const wrongConversation = { ...request, conversation: resolveConversationBinding(other.manager) };
			await expect(f.coordinator.snapshot(wrongConversation)).rejects.toThrow();
			await expect(f.coordinator.delivered(wrongConversation, [receipt])).rejects.toThrow();
			await expect(
				f.coordinator.admit({
					request: wrongConversation,
					selected: [{ entryId: "foreign-entry", event: foreign, receipt, envelope: foreign.envelope }],
					dispositions: [],
				}),
			).rejects.toThrow();
			expect(f.coordinator.inspectEvent(foreign)).toMatchObject({
				state: "pending",
				readAt: null,
				deliveredAt: null,
			});
			expect(f.coordinator.inspectConsumption(foreign)).toBe("foreign-wait");
		} finally {
			f.cleanup();
			other.cleanup();
		}
	});
});

describe("request admission authority", () => {
	it("commits immutable chained entries with exact timestamps, verified receipts and matching consumption", async () => {
		let now = 1000;
		const f = await createAdmissionHarness({ clock: () => now });
		try {
			const a = f.coordinator.seedEvent("a", "one");
			const b = f.coordinator.seedEvent("b", "two");
			const proposal = await proposalFor(f, [a, b]);
			f.coordinator.seedMatchingConsumption(a, "wait-a");
			now = 2000;
			const result = await f.coordinator.admit(proposal);
			expect(result.entries).toEqual([
				{
					entryId: "reserved-0",
					timestamp: new Date(now).toISOString(),
					record: {
						...a,
						kind: "admission",
						requestId: "request",
						instanceId: f.fence.instanceId,
						epoch: f.fence.epoch,
						branchAnchor: proposal.request.branchAnchor,
					},
				},
				{
					entryId: "reserved-1",
					timestamp: new Date(now).toISOString(),
					record: {
						...b,
						kind: "admission",
						requestId: "request",
						instanceId: f.fence.instanceId,
						epoch: f.fence.epoch,
						branchAnchor: "reserved-0",
					},
				},
			]);
			expect(f.coordinator.inspectEvent(a)).toMatchObject({
				state: "read",
				deliveredAt: 1000,
				readAt: 2000,
				receipt: proposal.selected[0]!.receipt,
			});
			expect(f.coordinator.inspectConsumption(a)).toBeNull();
			expect(await f.coordinator.admit(proposal)).toEqual(result);
			expect(
				await f.coordinator.admit({
					...proposal,
					request: {
						...proposal.request,
						fence: {
							...proposal.request.fence,
							connectionId: "new-connection",
							connectionRevision: 99,
							verificationRevision: 100,
						},
					},
				}),
			).toEqual(result);
			expect(f.coordinator.inspectRequest("request")?.proposal.selected).toEqual(proposal.selected);
			await expect(
				f.coordinator.admit({ ...proposal, selected: [{ ...proposal.selected[0]!, envelope: "changed" }] }),
			).rejects.toThrow("Conflicting");
			const reopened = new FakeRequestCoordinator(
				f.runtimeCoordinator,
				() => now,
				f.coordinator.exportRecoveryImage(),
			);
			expect(await reopened.lookup("request")).toEqual(result);
			expect((await reopened.recover(proposal.request.conversation)).commits).toEqual([result]);
			expect(JSON.stringify(reopened.exportRecoveryImage())).not.toContain(f.fence.generationToken);
		} finally {
			f.cleanup();
		}
	});
	it("serializes expiry before commit without consuming a matching target", async () => {
		let now = 1000;
		const f = await createAdmissionHarness({ clock: () => now });
		try {
			const event = f.coordinator.seedEvent("expires", "body", 2000);
			const proposal = await proposalFor(f, [event]);
			f.coordinator.seedMatchingConsumption(event, "wait");
			const gate = f.coordinator.holdNextAdmission();
			const result = f.coordinator.admit(proposal);
			await gate.received;
			now = 2000;
			gate.commit();
			await gate.committed;
			gate.respond();
			expect(await result).toMatchObject({ entries: [], dispositions: [{ eventId: "expires", code: "expired" }] });
			expect(f.coordinator.inspectEvent(event)).toMatchObject({ state: "expired", readAt: null, deliveredAt: 1000 });
			expect(f.coordinator.inspectConsumption(event)).toBe("wait");
		} finally {
			f.cleanup();
		}
	});
	it("revalidates stale epoch at commit before any read or consumption", async () => {
		const f = await createAdmissionHarness({ clock: () => 1000 });
		try {
			const event = f.coordinator.seedEvent("stale", "body");
			const proposal = await proposalFor(f, [event]);
			f.coordinator.seedMatchingConsumption(event, "wait");
			const gate = f.coordinator.holdNextAdmission();
			const pending = f.coordinator.admit(proposal);
			const response = expect(pending).rejects.toThrow(/stale/);
			const committed = expect(gate.committed).rejects.toThrow(/stale/);
			await gate.received;
			f.harness.session.runtimeLifecycle.cancel();
			await f.harness.session.runtimeLifecycle.reconcile(f.runtimeCoordinator.exchange);
			gate.commit();
			await committed;
			await response;
			expect(f.coordinator.inspectEvent(event)).toMatchObject({ state: "pending", readAt: null });
			expect(f.coordinator.inspectConsumption(event)).toBe("wait");
			expect(await f.coordinator.lookup("request")).toBeUndefined();
		} finally {
			f.cleanup();
		}
	});
	it("commits before expiry even when the response arrives after expiry", async () => {
		let now = 1000;
		const f = await createAdmissionHarness({ clock: () => now });
		try {
			const event = f.coordinator.seedEvent("early", "body", 2000);
			const proposal = await proposalFor(f, [event]);
			f.coordinator.seedMatchingConsumption(event, "wait");
			const gate = f.coordinator.holdNextAdmission();
			const pending = f.coordinator.admit(proposal);
			await gate.received;
			now = 1999;
			gate.commit();
			await gate.committed;
			now = 2000;
			gate.respond();
			const result = await pending;
			expect(result.entries[0]).toMatchObject({
				entryId: "reserved-0",
				timestamp: new Date(1999).toISOString(),
				record: { eventId: "early" },
			});
			expect(f.coordinator.inspectEvent(event)).toMatchObject({ state: "read", readAt: 1999 });
			expect(f.coordinator.inspectConsumption(event)).toBeNull();
		} finally {
			f.cleanup();
		}
	});
	it("does not consume a dropped or already-read event", async () => {
		const f = await createAdmissionHarness({ clock: () => 1000 });
		try {
			const dropped = f.coordinator.seedEvent("dropped", "body");
			const read = f.coordinator.seedEvent("read", "body");
			const first = await proposalFor(f, [read], "first");
			await f.coordinator.admit(first);
			const second = await proposalFor(f, [dropped, read], "second");
			f.coordinator.seedMatchingConsumption(dropped, "drop-wait");
			f.coordinator.seedMatchingConsumption(read, "read-wait");
			f.coordinator.dropEvent(dropped);
			const result = await f.coordinator.admit(second);
			expect(result.entries).toEqual([]);
			expect(result.dispositions.map((disposition) => disposition.code)).toEqual(["dropped", "already-read"]);
			expect(f.coordinator.inspectConsumption(dropped)).toBe("drop-wait");
			expect(f.coordinator.inspectConsumption(read)).toBe("read-wait");
		} finally {
			f.cleanup();
		}
	});
	it("rejects forged receipts and stale generations without changing read or matching state", async () => {
		const f = await createAdmissionHarness({ clock: () => 1000 });
		try {
			const event = f.coordinator.seedEvent("unfit", "body");
			const proposal = await proposalFor(f, [event]);
			f.coordinator.seedMatchingConsumption(event, "wait");
			const forged = {
				...proposal,
				selected: [{ ...proposal.selected[0]!, receipt: { ...proposal.selected[0]!.receipt, entryId: "forged" } }],
			};
			await expect(f.coordinator.delivered(proposal.request, [forged.selected[0]!.receipt])).rejects.toThrow();
			await expect(f.coordinator.admit(forged)).rejects.toThrow();
			await expect(
				f.coordinator.admit({
					...proposal,
					selected: [{ ...proposal.selected[0]!, entryId: f.manager.getLeafId()! }],
				}),
			).rejects.toThrow();
			await expect(
				f.coordinator.admit({ ...proposal, request: { ...proposal.request, branchAnchor: "missing" } }),
			).rejects.toThrow();
			await expect(
				f.coordinator.admit({
					...proposal,
					request: { ...proposal.request, fence: { ...f.fence, generation: f.fence.generation + 1 } },
				}),
			).rejects.toThrow(/stale/);
			expect(f.coordinator.inspectEvent(event)).toMatchObject({ state: "pending", readAt: null });
			expect(f.coordinator.inspectConsumption(event)).toBe("wait");
			expect(await f.coordinator.lookup("request")).toBeUndefined();
		} finally {
			f.cleanup();
		}
	});
	it("recovers a lost response without reselection", async () => {
		const f = await createAdmissionHarness({ clock: () => 1000 });
		try {
			const event = f.coordinator.seedEvent("lost", "body");
			const proposal = await proposalFor(f, [event]);
			const gate = f.coordinator.holdNextAdmission();
			const pending = f.coordinator.admit(proposal);
			const rejected = expect(pending).rejects.toThrow("lost response");
			await gate.received;
			gate.commit();
			await gate.committed;
			gate.rejectResponse(new Error("lost response"));
			await rejected;
			const committed = await f.coordinator.lookup("request");
			expect(committed?.entries).toHaveLength(1);
			expect(committed?.entries[0]?.record.eventId).toBe("lost");
			expect(f.coordinator.inspectEvent(event)?.readAt).toBe(1000);
			expect(await f.coordinator.admit(proposal)).toEqual(committed);
		} finally {
			f.cleanup();
		}
	});
});
