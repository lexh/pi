import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateTokens, prepareCompaction } from "../../src/core/compaction/compaction.ts";
import { CANDIDATE_MESSAGE } from "../../src/core/durable-records.ts";
import { readExternalEntry } from "../../src/core/external-event-records.ts";
import { createAdmissionHarness } from "../helpers/request-admission.ts";

function corruptCandidates(harness: Awaited<ReturnType<typeof createAdmissionHarness>>["harness"]): void {
	const previous = harness.session.agent.transformContext;
	harness.session.agent.transformContext = async (messages, signal) => {
		const transformed = (await previous?.(messages, signal)) ?? messages;
		return transformed.map((message) =>
			message.role === "custom" && message.customType === CANDIDATE_MESSAGE
				? { ...message, content: "corrupted" }
				: message,
		);
	};
}

describe("finite canonical request barrier", () => {
	const fixtures: Array<Awaited<ReturnType<typeof createAdmissionHarness>>> = [];
	afterEach(() => {
		for (const fixture of fixtures.splice(0)) fixture.cleanup();
	});

	it.each([0, -1] as const)(
		"reserves later mandatory dispositions at the exact boundary offset %i",
		async (offset) => {
			const fixture = await createAdmissionHarness({
				settings: { compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 1 } },
			});
			fixtures.push(fixture);
			const { harness, coordinator } = fixture;
			const old = coordinator.seedEvent("budget-old", "BUDGET_OLD_CONTROL");
			harness.session.requestAdmission.bind(coordinator);
			harness.setResponses([fauxAssistantMessage("setup")]);
			await harness.session.prompt("setup");
			expect(coordinator.inspectEvent(old)?.state).toBe("read");
			const first = coordinator.seedEvent("budget-first", `FIRST_WHOLE ${"a".repeat(1200)}`);
			const second = coordinator.seedEvent("budget-second", `SECOND_WHOLE ${"b".repeat(6000)}`);
			coordinator.seedMatchingConsumption(first, "claim-first");
			coordinator.seedMatchingConsumption(second, "claim-second");
			const basis = { commit: "old", uncommittedDigest: "old-digest", coverage: "full" as const };
			const current = { commit: "new", uncommittedDigest: "new-digest", coverage: "full" as const };
			const originalSnapshot = coordinator.snapshot.bind(coordinator);
			vi.spyOn(coordinator, "snapshot").mockImplementation(async (request, signal) => {
				const snapshot = await originalSnapshot(request, signal);
				return {
					...snapshot,
					candidates: snapshot.candidates.map((candidate) => ({ ...candidate, workspaceBasis: basis })),
				};
			});
			vi.spyOn(coordinator, "workspace").mockResolvedValue({ recipient: current, helpers: [] });
			const finalize = harness.session.agent.finalizeRequest;
			if (!finalize) throw new Error("missing finalizer");
			let boundary = 0;
			let expectedEnvelope = "";
			harness.session.agent.finalizeRequest = (request, signal) => {
				const candidateMessages = request.context.messages.filter((message) =>
					/FIRST_WHOLE|SECOND_WHOLE/.test(JSON.stringify(message)),
				);
				const firstSlot = candidateMessages.find((message) => JSON.stringify(message).includes("FIRST_WHOLE"));
				if (!firstSlot) throw new Error("missing first slot");
				const base = request.context.messages.filter((message) => !candidateMessages.includes(message));
				const disposition = {
					role: "user" as const,
					content: [
						{
							type: "text" as const,
							text: `[External event disposition: recipient=${JSON.stringify(second.recipientIdentity)} event=${JSON.stringify(second.eventId)} status=deferred-budget reason="insufficient request capacity"]`,
						},
					],
					timestamp: 0,
				};
				if (firstSlot.role !== "user" || !Array.isArray(firstSlot.content) || firstSlot.content[0]?.type !== "text")
					throw new Error("missing text");
				const decorated = {
					...firstSlot,
					content: [
						{
							type: "text" as const,
							text: `${firstSlot.content[0].text}\nWorkspace basis: commit="old" uncommitted="old-digest" coverage=full.\nCurrent workspace at admission: commit="new" uncommitted="new-digest" coverage=full.\nThe workspace changed after the sender's cited/request-start basis; assess this information against the current state.`,
						},
					],
				};
				expectedEnvelope = decorated.content[0].text;
				boundary = [...base, decorated, disposition].reduce((sum, message) => sum + estimateTokens(message), 0);
				return finalize({ ...request, model: { ...request.model, contextWindow: boundary + offset } }, signal);
			};
			const requests: unknown[] = [];
			harness.setResponses([
				(context) => {
					requests.push(structuredClone(context));
					return fauxAssistantMessage("target");
				},
			]);
			const admit = vi.spyOn(coordinator, "admit");
			await harness.session.prompt("BUDGET_ORDINARY");
			expect(boundary).toBeGreaterThan(0);
			expect(harness.faux.state.callCount).toBe(2);
			expect(admit).toHaveBeenCalledTimes(1);
			expect(requests).toHaveLength(1);
			const payload = JSON.stringify(requests[0]);
			expect(payload).toContain("BUDGET_OLD_CONTROL");
			expect(payload).toContain("BUDGET_ORDINARY");
			expect(payload).toContain("budget-second");
			expect(payload).toContain("deferred-budget");
			expect(payload).not.toContain("SECOND_WHOLE");
			if (offset === 0) {
				expect(payload).toContain(JSON.stringify(expectedEnvelope));
				expect(expectedEnvelope).toContain(first.envelope);
				expect(expectedEnvelope).toContain("Workspace basis:");
				expect(coordinator.inspectEvent(first)?.state).toBe("read");
				expect(coordinator.inspectConsumption(first)).toBeNull();
			} else {
				expect(payload).not.toContain("FIRST_WHOLE");
				expect(coordinator.inspectEvent(first)?.state).toBe("pending");
				expect(coordinator.inspectConsumption(first)).toBe("claim-first");
			}
			expect(coordinator.inspectEvent(second)?.state).toBe("pending");
			expect(coordinator.inspectConsumption(second)).toBe("claim-second");
		},
	);

	it.each([0, Number.NaN, 1])("blocks coordination at unavailable or insufficient capacity %s", async (capacity) => {
		const fixture = await createAdmissionHarness({
			settings: { compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 1 } },
		});
		fixtures.push(fixture);
		const event = fixture.coordinator.seedEvent("no-space", "NO_SPACE_PRIVATE");
		fixture.coordinator.seedMatchingConsumption(event, "no-space-claim");
		fixture.harness.session.requestAdmission.bind(fixture.coordinator);
		const finalize = fixture.harness.session.agent.finalizeRequest;
		if (!finalize) throw new Error("missing finalizer");
		fixture.harness.session.agent.finalizeRequest = (request, signal) =>
			finalize({ ...request, model: { ...request.model, contextWindow: capacity } }, signal);
		const admit = vi.spyOn(fixture.coordinator, "admit");
		await fixture.harness.session.prompt("ordinary");
		expect(fixture.harness.eventsOfType("request_suppressed")).toMatchObject([{ reason: "admission-budget" }]);
		expect(admit).not.toHaveBeenCalled();
		expect(fixture.harness.faux.state.callCount).toBe(0);
		expect(fixture.coordinator.inspectEvent(event)?.state).toBe("pending");
		expect(fixture.coordinator.inspectConsumption(event)).toBe("no-space-claim");
	});

	it("excludes a locally expired staged candidate before the atomic proposal", async () => {
		const fixture = await createAdmissionHarness();
		fixtures.push(fixture);
		const event = fixture.coordinator.seedEvent("locally-expired", "LOCAL_PRIVATE", Date.now() + 60_000);
		fixture.coordinator.seedMatchingConsumption(event, "local-claim");
		const original = fixture.coordinator.snapshot.bind(fixture.coordinator);
		vi.spyOn(fixture.coordinator, "snapshot").mockImplementation(async (request, signal) => {
			const snapshot = await original(request, signal);
			return {
				...snapshot,
				candidates: snapshot.candidates.map((candidate) => ({ ...candidate, expiresAt: Date.now() - 1 })),
			};
		});
		fixture.harness.session.requestAdmission.bind(fixture.coordinator);
		const admit = vi.spyOn(fixture.coordinator, "admit");
		const requests: unknown[] = [];
		fixture.harness.setResponses([
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("done");
			},
		]);
		await fixture.harness.session.prompt("ordinary");
		expect(admit).toHaveBeenCalledTimes(1);
		expect(admit.mock.calls[0][0].selected).toHaveLength(0);
		expect(JSON.stringify(requests[0])).toContain("status=expired");
		expect(JSON.stringify(requests[0])).not.toContain("LOCAL_PRIVATE");
		expect(fixture.coordinator.inspectEvent(event)?.state).toBe("pending");
		expect(fixture.coordinator.inspectConsumption(event)).toBe("local-claim");
		expect(fixture.harness.faux.state.callCount).toBe(1);
	});

	it("commits an unexpired subset and consumption atomically after a held expiry race", async () => {
		let now = Date.now();
		const fixture = await createAdmissionHarness({ clock: () => now });
		fixtures.push(fixture);
		const expired = fixture.coordinator.seedEvent("race-expired", "RACE_PRIVATE", now + 10_000);
		const accepted = fixture.coordinator.seedEvent("race-accepted", "RACE_ACCEPTED");
		fixture.coordinator.seedMatchingConsumption(expired, "expired-claim");
		fixture.coordinator.seedMatchingConsumption(accepted, "accepted-claim");
		fixture.harness.session.requestAdmission.bind(fixture.coordinator);
		const gate = fixture.coordinator.holdNextAdmission();
		const admit = vi.spyOn(fixture.coordinator, "admit");
		const requests: unknown[] = [];
		fixture.harness.setResponses([
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("done");
			},
		]);
		const running = fixture.harness.session.prompt("ordinary");
		await gate.received;
		expect(fixture.coordinator.inspectConsumption(accepted)).toBe("accepted-claim");
		expect(fixture.coordinator.inspectEvent(accepted)?.state).toBe("pending");
		now += 20_000;
		gate.commit();
		await gate.committed;
		const requestId = admit.mock.calls[0][0].request.requestId;
		const committed = await fixture.coordinator.lookup(requestId);
		expect(committed?.entries.map((entry) => entry.record.eventId)).toEqual(["race-accepted"]);
		expect(committed?.entries[0].record.branchAnchor).toBe(admit.mock.calls[0][0].request.branchAnchor);
		expect(fixture.coordinator.inspectEvent(accepted)?.state).toBe("read");
		expect(fixture.coordinator.inspectConsumption(accepted)).toBeNull();
		expect(fixture.coordinator.inspectConsumption(expired)).toBe("expired-claim");
		gate.respond();
		await running;
		expect(fixture.harness.faux.state.callCount).toBe(1);
		expect(JSON.stringify(requests[0])).toContain("RACE_ACCEPTED");
		expect(JSON.stringify(requests[0])).not.toContain("RACE_PRIVATE");
		expect(JSON.stringify(requests[0])).toContain("status=expired");
		expect(await fixture.coordinator.lookup(requestId)).toEqual(committed);
		expect(admit).toHaveBeenCalledTimes(1);
	});

	it("reuses two real admissions in future requests and both real summary paths", async () => {
		const fixture = await createAdmissionHarness({
			settings: { compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 1 } },
		});
		fixtures.push(fixture);
		const { harness, coordinator, manager } = fixture;
		const one = coordinator.seedEvent("history-one", "HISTORY_ONE");
		const two = coordinator.seedEvent("history-two", "HISTORY_TWO");
		harness.session.requestAdmission.bind(coordinator);
		const root = manager.getLeafId();
		const admit = vi.spyOn(coordinator, "admit");
		harness.setResponses([fauxAssistantMessage("initial response")]);
		await harness.session.prompt("first input");
		const result = coordinator.inspectRequest(admit.mock.calls[0][0].request.requestId)?.result;
		if (!result) throw new Error("missing commit");
		expect(result.entries.map((entry) => entry.record.eventId)).toEqual(["history-one", "history-two"]);
		expect(result.entries[0].record.branchAnchor).toBe(admit.mock.calls[0][0].request.branchAnchor);
		expect(result.entries[1].record.branchAnchor).toBe(result.entries[0].entryId);
		const leaf = manager.getEntry(manager.getLeafId()!);
		expect(leaf?.type).toBe("message");
		if (leaf?.type !== "message") throw new Error("missing assistant");
		expect(leaf.message.role).toBe("assistant");
		expect(leaf.parentId).toBe(result.entries[1].entryId);
		expect(harness.session.messages).toEqual(manager.buildSessionProjection().messages);
		for (const event of [one, two]) {
			expect(
				harness.session
					.getExternalEventView()
					.filter((item) => item.type === "external_event" && item.record.eventId === event.eventId),
			).toHaveLength(1);
		}
		const reads = [coordinator.inspectEvent(one)?.readAt, coordinator.inspectEvent(two)?.readAt];
		const secondRequests: unknown[] = [];
		harness.setResponses([
			(context) => {
				secondRequests.push(structuredClone(context));
				return fauxAssistantMessage("second response");
			},
		]);
		await harness.session.prompt("second input");
		expect(admit).toHaveBeenCalledTimes(1);
		expect([coordinator.inspectEvent(one)?.readAt, coordinator.inspectEvent(two)?.readAt]).toEqual(reads);
		expect(JSON.stringify(secondRequests[0]).match(/HISTORY_ONE/g)).toHaveLength(1);
		expect(JSON.stringify(secondRequests[0]).match(/HISTORY_TWO/g)).toHaveLength(1);
		const pending = coordinator.seedEvent("history-pending", "PENDING_HISTORY_PRIVATE");
		const previous = harness.session.agent.transformContext;
		harness.session.agent.transformContext = async (messages, signal) =>
			((await previous?.(messages, signal)) ?? messages).filter(
				(message) => !(message.role === "custom" && message.customType === CANDIDATE_MESSAGE),
			);
		harness.setResponses([fauxAssistantMessage("third response")]);
		await harness.session.prompt("third input");
		expect(coordinator.inspectEvent(pending)?.state).toBe("pending");
		const target = root;
		if (!target) throw new Error("missing branch root");
		const beforeNavigation = manager.getLeafId();
		const summaries: unknown[] = [];
		harness.setResponses([
			(context) => {
				summaries.push(structuredClone(context));
				return fauxAssistantMessage("branch summary");
			},
		]);
		await harness.session.navigateTree(target, { summarize: true });
		expect(summaries).toHaveLength(1);
		expect(JSON.stringify(summaries[0])).toContain("HISTORY_ONE");
		expect(JSON.stringify(summaries[0])).toContain("HISTORY_TWO");
		expect(JSON.stringify(summaries[0])).not.toContain("PENDING_HISTORY_PRIVATE");
		if (!beforeNavigation) throw new Error("missing leaf");
		await harness.session.navigateTree(beforeNavigation, { summarize: false });
		harness.setResponses([
			(context) => {
				summaries.push(structuredClone(context));
				return fauxAssistantMessage("compact summary");
			},
			(context) => {
				summaries.push(structuredClone(context));
				return fauxAssistantMessage("turn prefix summary");
			},
		]);
		await harness.session.compact();
		expect(summaries).toHaveLength(3);
		expect(JSON.stringify(summaries.slice(1))).toContain("HISTORY_ONE");
		expect(JSON.stringify(summaries.slice(1))).toContain("HISTORY_TWO");
		expect(JSON.stringify(summaries.slice(1))).not.toContain("PENDING_HISTORY_PRIVATE");
		expect(manager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
		expect(manager.getEntries().some((entry) => entry.type === "branch_summary")).toBe(true);
		expect(harness.faux.state.callCount).toBe(6);
		expect(admit).toHaveBeenCalledTimes(2);
	});

	it("admits only the retained complete event into the actual provider request", async () => {
		const fixture = await createAdmissionHarness();
		fixtures.push(fixture);
		const { coordinator, harness } = fixture;
		const old = coordinator.seedEvent("old-control", "EARLIER_ADMITTED_CONTROL");
		harness.session.requestAdmission.bind(coordinator);
		harness.setResponses([fauxAssistantMessage("setup response")]);
		await harness.session.prompt("earlier authorized request");
		expect(harness.faux.state.callCount).toBe(1);
		expect(coordinator.inspectEvent(old)?.state).toBe("read");
		const live = JSON.stringify(harness.session.messages);
		expect(live.match(/EARLIER_ADMITTED_CONTROL/g)).toHaveLength(1);
		expect(live.match(/setup response/g)).toHaveLength(1);
		expect(live).not.toContain(CANDIDATE_MESSAGE);
		expect(live.indexOf("EARLIER_ADMITTED_CONTROL")).toBeLessThan(live.indexOf("setup response"));
		expect(harness.session.messages).toEqual(fixture.manager.buildSessionProjection().messages);
		const keep = coordinator.seedEvent("keep", "KEEP_BODY");
		const drop = coordinator.seedEvent("drop", "DROP_BODY");
		const previous = harness.session.agent.transformContext;
		harness.session.agent.transformContext = async (messages, signal) => {
			const transformed = (await previous?.(messages, signal)) ?? messages;
			return transformed.filter(
				(message) =>
					message.role !== "custom" ||
					message.customType !== CANDIDATE_MESSAGE ||
					typeof message.details !== "object" ||
					message.details === null ||
					!("eventId" in message.details) ||
					message.details.eventId !== "drop",
			);
		};
		const requests: unknown[] = [];
		harness.setResponses([
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("done");
			},
		]);
		const admit = vi.spyOn(coordinator, "admit");
		await harness.session.prompt("ordinary user control");
		expect(harness.faux.state.callCount).toBe(2);
		expect(requests).toHaveLength(1);
		const payload = JSON.stringify(requests[0]);
		expect(payload).toContain("KEEP_BODY");
		expect(payload).not.toContain("DROP_BODY");
		expect(payload).toContain("ordinary user control");
		expect(payload).toContain("EARLIER_ADMITTED_CONTROL");
		expect(coordinator.inspectEvent(keep)).toMatchObject({ state: "read" });
		expect(coordinator.inspectEvent(drop)).toMatchObject({
			state: "pending",
			deliveredAt: expect.any(Number),
			readAt: null,
		});
		expect(admit).toHaveBeenCalledTimes(1);
		const requestId = admit.mock.calls[0][0].request.requestId;
		const committed = coordinator.inspectRequest(requestId)?.result.entries;
		expect(committed?.map((entry) => entry.record.eventId)).toEqual(["keep"]);
		expect(fixture.manager.getBranch().filter((entry) => entry.id === committed?.[0].entryId)).toHaveLength(1);
	});

	it.each(["corrupt", "duplicate", "omit", "merge"] as const)(
		"suppresses %s normalized candidate conversion without reads",
		async (kind) => {
			const fixture = await createAdmissionHarness();
			fixtures.push(fixture);
			const event = fixture.coordinator.seedEvent("strict", "STRICT_PRIVATE_BODY");
			fixture.harness.session.requestAdmission.bind(fixture.coordinator);
			const convert = fixture.harness.session.agent.convertToLlm;
			fixture.harness.session.agent.convertToLlm = async (messages) => {
				const converted = await convert(messages);
				const index = converted.findIndex((message) => JSON.stringify(message).includes("STRICT_PRIVATE_BODY"));
				if (index < 0) throw new Error("candidate not converted");
				const found = converted[index];
				if (kind === "omit") return converted.filter((_, i) => i !== index);
				if (kind === "duplicate") return [...converted, found];
				if (kind === "corrupt")
					return converted.map((message, i) =>
						i === index
							? { role: "user" as const, content: "altered candidate", timestamp: message.timestamp }
							: message,
					);
				return converted.map((message, i) =>
					i === index
						? { role: "user" as const, content: `${JSON.stringify(found)} MERGED`, timestamp: message.timestamp }
						: message,
				);
			};
			const admit = vi.spyOn(fixture.coordinator, "admit");
			await fixture.harness.session.prompt("ordinary");
			expect(admit).not.toHaveBeenCalled();
			expect(fixture.harness.faux.state.callCount).toBe(0);
			expect(fixture.coordinator.inspectEvent(event)).toMatchObject({ state: "pending", readAt: null });
			expect(fixture.harness.eventsOfType("request_suppressed")).toMatchObject([{ reason: "candidate-corrupt" }]);
		},
	);

	it.each(["id", "order", "anchor", "envelope", "extra"] as const)(
		"rejects a committed response with altered %s",
		async (kind) => {
			const fixture = await createAdmissionHarness();
			fixtures.push(fixture);
			const one = fixture.coordinator.seedEvent("invalid-one", "INVALID_ONE");
			const two = fixture.coordinator.seedEvent("invalid-two", "INVALID_TWO");
			fixture.harness.session.requestAdmission.bind(fixture.coordinator);
			const original = fixture.coordinator.admit.bind(fixture.coordinator);
			const admit = vi.spyOn(fixture.coordinator, "admit").mockImplementation(async (proposal, signal) => {
				const result = await original(proposal, signal);
				if (kind === "id") result.requestId = "wrong";
				if (kind === "order") result.entries = [...result.entries].reverse();
				if (kind === "anchor") result.entries[0].record.branchAnchor = "wrong";
				if (kind === "envelope") result.entries[0].record.envelope += "wrong";
				if (kind === "extra") result.entries = [...result.entries, { ...result.entries[1], entryId: "extra" }];
				return result;
			});
			await fixture.harness.session.prompt("ordinary");
			expect(admit).toHaveBeenCalledTimes(1);
			expect(fixture.coordinator.inspectEvent(one)?.state).toBe("read");
			expect(fixture.coordinator.inspectEvent(two)?.state).toBe("read");
			expect(fixture.harness.faux.state.callCount).toBe(0);
			expect(
				fixture.manager
					.getEntries()
					.flatMap((entry) => readExternalEntry(entry) ?? [])
					.filter((entry) => entry.kind === "admission"),
			).toHaveLength(0);
			expect(fixture.harness.eventsOfType("request_suppressed")).toMatchObject([{ reason: "admission-invalid" }]);
		},
	);

	it("rejects a commit produced after the authority mutates the proposal in place", async () => {
		const fixture = await createAdmissionHarness();
		fixtures.push(fixture);
		const event = fixture.coordinator.seedEvent("mutated", "ORIGINAL_BODY");
		fixture.harness.session.requestAdmission.bind(fixture.coordinator);
		const admitOriginal = fixture.coordinator.admit.bind(fixture.coordinator);
		const admit = vi.spyOn(fixture.coordinator, "admit").mockImplementation(async (proposal, signal) => {
			proposal.selected[0].envelope += " ALTERED";
			return admitOriginal(proposal, signal);
		});
		await fixture.harness.session.prompt("ordinary");
		expect(admit).toHaveBeenCalledTimes(1);
		expect(fixture.coordinator.inspectEvent(event)?.state).toBe("read");
		expect(fixture.harness.faux.state.callCount).toBe(0);
		expect(
			fixture.manager
				.getEntries()
				.flatMap((entry) => readExternalEntry(entry) ?? [])
				.filter((item) => item.kind === "admission"),
		).toHaveLength(0);
		expect(fixture.harness.eventsOfType("request_suppressed")).toMatchObject([{ reason: "admission-invalid" }]);
	});

	it("rejects an in-place corrupted response after a safe authority commit", async () => {
		const fixture = await createAdmissionHarness();
		fixtures.push(fixture);
		const event = fixture.coordinator.seedEvent("response-mutated", "ORIGINAL_RESPONSE_BODY");
		fixture.harness.session.requestAdmission.bind(fixture.coordinator);
		const original = fixture.coordinator.admit.bind(fixture.coordinator);
		const admit = vi.spyOn(fixture.coordinator, "admit").mockImplementation(async (proposal, signal) => {
			const result = await original(proposal, signal);
			result.entries[0].record.envelope += " ALTERED";
			return result;
		});
		await fixture.harness.session.prompt("ordinary");
		expect(admit).toHaveBeenCalledTimes(1);
		expect(fixture.coordinator.inspectEvent(event)?.state).toBe("read");
		expect(fixture.harness.faux.state.callCount).toBe(0);
		expect(
			fixture.manager
				.getEntries()
				.flatMap((entry) => readExternalEntry(entry) ?? [])
				.filter((item) => item.kind === "admission"),
		).toHaveLength(0);
		expect(fixture.harness.eventsOfType("request_suppressed")).toMatchObject([{ reason: "admission-invalid" }]);
	});

	it.each(["foreign", "empty", "long", "invalid-code", "invalid-reason", "duplicate", "candidate-conflict"] as const)(
		"rejects %s snapshot dispositions before delivery",
		async (kind) => {
			const fixture = await createAdmissionHarness();
			fixtures.push(fixture);
			const event = fixture.coordinator.seedEvent("candidate", "BODY");
			fixture.harness.session.requestAdmission.bind(fixture.coordinator);
			const snapshotOriginal = fixture.coordinator.snapshot.bind(fixture.coordinator);
			vi.spyOn(fixture.coordinator, "snapshot").mockImplementation(async (request, signal) => {
				const snapshot = await snapshotOriginal(request, signal);
				const item = {
					recipientIdentity: kind === "foreign" ? "foreign" : fixture.fence.mailboxId,
					eventId:
						kind === "empty"
							? ""
							: kind === "long"
								? "x".repeat(257)
								: kind === "candidate-conflict"
									? "candidate"
									: "other",
					code: "expired" as const,
					reason: "expired",
				};
				if (kind === "invalid-code") Object.assign(item, { code: "bogus" });
				if (kind === "invalid-reason") Object.assign(item, { reason: "" });
				return { ...snapshot, dispositions: kind === "duplicate" ? [item, item] : [item] };
			});
			const delivered = vi.spyOn(fixture.coordinator, "delivered");
			const admit = vi.spyOn(fixture.coordinator, "admit");
			await fixture.harness.session.prompt("ordinary");
			expect(delivered).not.toHaveBeenCalled();
			expect(admit).not.toHaveBeenCalled();
			expect(fixture.coordinator.inspectEvent(event)).toMatchObject({
				state: "pending",
				readAt: null,
				deliveredAt: null,
			});
			expect(fixture.harness.faux.state.callCount).toBe(0);
		},
	);

	it("accepts an ordinary expired mailbox event without a completed-wait reference", async () => {
		const fixture = await createAdmissionHarness();
		fixtures.push(fixture);
		const event = fixture.coordinator.seedEvent("ordinary-expired", "EXPIRED_PRIVATE", Date.now() - 1);
		fixture.harness.session.requestAdmission.bind(fixture.coordinator);
		const original = fixture.coordinator.snapshot.bind(fixture.coordinator);
		const snapshot = vi.spyOn(fixture.coordinator, "snapshot").mockImplementation(async (request, signal) => {
			const result = await original(request, signal);
			return {
				...result,
				dispositions: [
					{
						recipientIdentity: event.recipientIdentity,
						eventId: event.eventId,
						code: "expired",
						reason: "expired",
					},
				],
			};
		});
		const requests: unknown[] = [];
		fixture.harness.setResponses([
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("done");
			},
		]);
		await fixture.harness.session.prompt("ordinary");
		expect(snapshot.mock.calls[0][0].references).toEqual([]);
		expect(fixture.harness.faux.state.callCount).toBe(1);
		expect(JSON.stringify(requests[0])).toContain("ordinary-expired");
		expect(JSON.stringify(requests[0])).not.toContain("EXPIRED_PRIVATE");
		expect(fixture.coordinator.inspectEvent(event)?.readAt).toBeNull();
	});

	it("does not alias identical event bodies across different identities", async () => {
		const fixture = await createAdmissionHarness();
		fixtures.push(fixture);
		const first = fixture.coordinator.seedEvent("same-a", "IDENTICAL_BODY");
		const second = fixture.coordinator.seedEvent("same-b", "IDENTICAL_BODY");
		const requests: unknown[] = [];
		fixture.harness.setResponses([
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("done");
			},
		]);
		const admit = vi.spyOn(fixture.coordinator, "admit");
		fixture.harness.session.requestAdmission.bind(fixture.coordinator);
		await fixture.harness.session.prompt("ordinary");
		expect(admit).toHaveBeenCalledTimes(1);
		expect(admit.mock.calls[0][0].selected.map((item) => item.event.eventId)).toEqual(["same-a", "same-b"]);
		expect(fixture.coordinator.inspectEvent(first)?.state).toBe("read");
		expect(fixture.coordinator.inspectEvent(second)?.state).toBe("read");
		expect(JSON.stringify(requests[0]).match(/IDENTICAL_BODY/g)).toHaveLength(2);
	});

	it.each([
		["before-settle", "overloaded_error"],
		["queued", "overloaded_error"],
		["queued", "maximum context length exceeded"],
	] as const)("stops a committed provider error before %s continuation (%s)", async (mode, errorMessage) => {
		let hooks = 0;
		const fixture = await createAdmissionHarness({
			settings: {
				retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
				compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 },
			},
			extensionFactories: [
				(pi) => {
					if (mode === "before-settle")
						pi.on("agent_before_settle", () => {
							hooks++;
							return { continue: true };
						});
				},
			],
		});
		fixtures.push(fixture);
		const event = fixture.coordinator.seedEvent("error-event", "ERROR_EVENT_BODY");
		fixture.harness.session.requestAdmission.bind(fixture.coordinator);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		fixture.harness.setResponses([
			async () => {
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage("", { stopReason: "error", errorMessage });
			},
			fauxAssistantMessage("unexpected continuation"),
		]);
		const snapshot = vi.spyOn(fixture.coordinator, "snapshot");
		const admit = vi.spyOn(fixture.coordinator, "admit");
		const running = fixture.harness.session.prompt("first");
		await entered.promise;
		if (mode === "queued") await fixture.harness.session.followUp("PRESERVED_FOLLOWUP");
		release.resolve();
		await running;
		expect(fixture.harness.faux.state.callCount).toBe(1);
		expect(snapshot).toHaveBeenCalledTimes(1);
		expect(admit).toHaveBeenCalledTimes(1);
		expect(fixture.coordinator.inspectEvent(event)?.state).toBe("read");
		expect(fixture.harness.eventsOfType("agent_end").map((value) => value.willRetry)).toEqual([false]);
		expect(hooks).toBe(0);
		expect(
			fixture.harness.eventsOfType("compaction_start").filter((item) => item.reason === "overflow"),
		).toHaveLength(0);
		if (mode === "queued") {
			expect(fixture.harness.session.pendingMessageCount).toBe(1);
			const requests: unknown[] = [];
			fixture.harness.setResponses(
				Array.from({ length: 4 }, () => (context) => {
					requests.push(structuredClone(context));
					return fauxAssistantMessage("later response");
				}),
			);
			await fixture.harness.session.prompt("explicit later request");
			expect(fixture.harness.session.pendingMessageCount).toBe(0);
			expect(JSON.stringify(requests)).toContain("PRESERVED_FOLLOWUP");
		}
	});

	it("runs a successful bound before-settle boundary after adoption", async () => {
		let hooks = 0;
		const fixture = await createAdmissionHarness({
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", () => {
						hooks++;
					});
				},
			],
		});
		fixtures.push(fixture);
		const event = fixture.coordinator.seedEvent("boundary", "BOUNDARY_BODY");
		fixture.harness.session.requestAdmission.bind(fixture.coordinator);
		fixture.harness.setResponses([fauxAssistantMessage("done")]);
		await fixture.harness.session.prompt("first");
		expect(hooks).toBe(1);
		expect(fixture.coordinator.inspectEvent(event)?.state).toBe("read");
		expect(fixture.harness.faux.state.callCount).toBe(1);
	});

	it("continues a successful committed request through a real tool call", async () => {
		const tool: AgentTool = {
			name: "check",
			label: "Check",
			description: "Return a result",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "TOOL_OK" }], details: {} }),
		};
		const fixture = await createAdmissionHarness({ tools: [tool] });
		fixtures.push(fixture);
		const event = fixture.coordinator.seedEvent("tool-event", "TOOL_EVENT_BODY");
		fixture.harness.session.requestAdmission.bind(fixture.coordinator);
		const snapshot = vi.spyOn(fixture.coordinator, "snapshot");
		const admit = vi.spyOn(fixture.coordinator, "admit");
		const requests: unknown[] = [];
		fixture.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("check", {}), { stopReason: "toolUse" }),
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("done");
			},
		]);
		await fixture.harness.session.prompt("first");
		expect(fixture.harness.faux.state.callCount).toBe(2);
		expect(snapshot).toHaveBeenCalledTimes(2);
		expect(admit).toHaveBeenCalledTimes(1);
		expect(fixture.coordinator.inspectEvent(event)?.state).toBe("read");
		expect(JSON.stringify(requests[0])).toContain("TOOL_OK");
		expect(JSON.stringify(requests[0]).match(/TOOL_EVENT_BODY/g)).toHaveLength(1);
	});

	it("suppresses a thrown provider iterator after the selected branch changes", async () => {
		const fixture = await createAdmissionHarness();
		fixtures.push(fixture);
		const event = fixture.coordinator.seedEvent("thrown", "STALE_BODY");
		fixture.harness.session.requestAdmission.bind(fixture.coordinator);
		fixture.harness.setResponses([fauxAssistantMessage("unused")]);
		const original = fixture.harness.session.agent.streamFunction;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		fixture.harness.session.agent.streamFunction = async (...args) => {
			const stream = await original(...args);
			Object.defineProperty(stream, Symbol.asyncIterator, {
				value: () => ({
					next: async () => {
						entered.resolve();
						await release.promise;
						throw new Error("ordinary iterator failure");
					},
				}),
			});
			return stream;
		};
		const admit = vi.spyOn(fixture.coordinator, "admit");
		const running = fixture.harness.session.prompt("original prompt");
		await entered.promise;
		const selected = fixture.manager.getBranch()[0].id;
		fixture.manager.branch(selected);
		release.resolve();
		await running;
		expect(admit).toHaveBeenCalledTimes(1);
		expect(fixture.coordinator.inspectEvent(event)?.state).toBe("read");
		expect(fixture.harness.faux.state.callCount).toBe(1);
		expect(fixture.manager.getLeafId()).toBe(selected);
		expect(
			fixture.manager.getBranch().filter((entry) => entry.type === "message" && entry.message.role === "assistant"),
		).toHaveLength(0);
		expect(fixture.harness.session.messages).toEqual(fixture.manager.buildSessionProjection().messages);
		expect(fixture.harness.eventsOfType("request_suppressed")).toMatchObject([{ reason: "coordination-stale" }]);
	});

	it("restores the newly selected projection when an adopted stream later throws", async () => {
		const fixture = await createAdmissionHarness();
		fixtures.push(fixture);
		const event = fixture.coordinator.seedEvent("started-error", "STARTED_BODY");
		fixture.harness.session.requestAdmission.bind(fixture.coordinator);
		fixture.harness.setResponses([fauxAssistantMessage("unused")]);
		const original = fixture.harness.session.agent.streamFunction;
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		fixture.harness.session.agent.streamFunction = async (...args) => {
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
						throw new Error("started iterator failure");
					},
				}),
			});
			return stream;
		};
		const running = fixture.harness.session.prompt("first");
		await entered.promise;
		const selected = fixture.manager.getBranch()[0].id;
		fixture.manager.branch(selected);
		release.resolve();
		await running;
		expect(fixture.coordinator.inspectEvent(event)?.state).toBe("read");
		expect(fixture.harness.faux.state.callCount).toBe(1);
		expect(fixture.manager.getLeafId()).toBe(selected);
		expect(fixture.harness.session.messages).toEqual(fixture.manager.buildSessionProjection().messages);
		expect(fixture.harness.eventsOfType("request_suppressed")).toMatchObject([{ reason: "coordination-stale" }]);
	});

	it("persists an owned ordinary iterator failure without retrying", async () => {
		const fixture = await createAdmissionHarness();
		fixtures.push(fixture);
		const event = fixture.coordinator.seedEvent("owned-error", "OWNED_BODY");
		fixture.harness.session.requestAdmission.bind(fixture.coordinator);
		fixture.harness.setResponses([fauxAssistantMessage("unused")]);
		const original = fixture.harness.session.agent.streamFunction;
		fixture.harness.session.agent.streamFunction = async (...args) => {
			const stream = await original(...args);
			Object.defineProperty(stream, Symbol.asyncIterator, {
				value: () => ({
					next: async () => {
						throw new Error("owned iterator error");
					},
				}),
			});
			return stream;
		};
		await fixture.harness.session.prompt("first");
		expect(fixture.coordinator.inspectEvent(event)?.state).toBe("read");
		expect(fixture.harness.faux.state.callCount).toBe(1);
		expect(fixture.harness.eventsOfType("request_suppressed")).toHaveLength(0);
		expect(
			fixture.manager
				.getBranch()
				.filter(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.errorMessage === "owned iterator error",
				),
		).toHaveLength(1);
	});

	it("suppresses a synthetic stream failure if selection changes during its listener", async () => {
		let fixture: Awaited<ReturnType<typeof createAdmissionHarness>>;
		let selected = "";
		fixture = await createAdmissionHarness({
			extensionFactories: [
				(pi) => {
					pi.on("message_end", async (event) => {
						if (event.message.role === "assistant" && event.message.errorMessage === "owned iterator failure") {
							selected = fixture.manager.getBranch()[0].id;
							fixture.manager.branch(selected);
						}
					});
				},
			],
		});
		fixtures.push(fixture);
		const event = fixture.coordinator.seedEvent("listener", "LISTENER_BODY");
		fixture.harness.session.requestAdmission.bind(fixture.coordinator);
		fixture.harness.setResponses([fauxAssistantMessage("unused")]);
		const original = fixture.harness.session.agent.streamFunction;
		fixture.harness.session.agent.streamFunction = async (...args) => {
			const stream = await original(...args);
			Object.defineProperty(stream, Symbol.asyncIterator, {
				value: () => ({
					next: async () => {
						throw new Error("owned iterator failure");
					},
				}),
			});
			return stream;
		};
		await fixture.harness.session.prompt("first");
		expect(selected).not.toBe("");
		expect(fixture.manager.getLeafId()).toBe(selected);
		expect(fixture.coordinator.inspectEvent(event)?.state).toBe("read");
		expect(fixture.harness.faux.state.callCount).toBe(1);
		expect(fixture.harness.session.messages).toEqual(fixture.manager.buildSessionProjection().messages);
		expect(fixture.harness.eventsOfType("request_suppressed")).toMatchObject([{ reason: "coordination-stale" }]);
	});

	it("captures one finite snapshot before acknowledging canonical delivery", async () => {
		const fixture = await createAdmissionHarness();
		fixtures.push(fixture);
		const { harness, coordinator } = fixture;
		const one = coordinator.seedEvent("one", "first unread body");
		const two = coordinator.seedEvent("two", "second unread body");
		const received = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const acknowledge = coordinator.delivered.bind(coordinator);
		const snapshot = vi.spyOn(coordinator, "snapshot");
		const delivered = vi.spyOn(coordinator, "delivered");
		const admit = vi.spyOn(coordinator, "admit");
		const requests: unknown[] = [];
		harness.setResponses([
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("first response");
			},
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("second response");
			},
		]);
		delivered.mockImplementation(async (request, receipts, signal) => {
			await acknowledge(request, receipts, signal);
			received.resolve();
			await release.promise;
		});
		harness.session.requestAdmission.bind(coordinator);

		const prompt = harness.session.prompt("first prompt");
		await received.promise;
		const three = coordinator.seedEvent("three", "late unread body");
		expect(snapshot).toHaveBeenCalledTimes(1);
		expect(coordinator.inspectEvent(one)?.deliveredAt).not.toBeNull();
		expect(coordinator.inspectEvent(two)?.deliveredAt).not.toBeNull();
		expect(coordinator.inspectEvent(three)?.deliveredAt).toBeNull();
		expect(fixture.manager.getEntries().flatMap((entry) => readExternalEntry(entry) ?? [])).toEqual([one, two]);
		expect(admit).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(0);
		release.resolve();
		await prompt;
		expect(
			harness.session
				.getExternalEventView()
				.filter((item) => item.type === "external_event" && item.record.eventId === "one"),
		).toHaveLength(1);
		expect(
			harness.session
				.getExternalEventView()
				.filter((item) => item.type === "external_event" && item.record.eventId === "two"),
		).toHaveLength(1);
		expect(admit).toHaveBeenCalledTimes(1);
		expect(admit.mock.calls[0][0].selected.map((item) => item.event.eventId)).toEqual(["one", "two"]);
		expect(harness.faux.state.callCount).toBe(1);
		expect(JSON.stringify(requests[0])).toContain("first unread body");
		expect(JSON.stringify(requests[0])).toContain("second unread body");
		expect(JSON.stringify(requests[0])).not.toContain("late unread body");
		expect(coordinator.inspectEvent(three)?.deliveredAt).toBeNull();
		await harness.session.prompt("second prompt");
		expect(snapshot).toHaveBeenCalledTimes(2);
		expect(coordinator.inspectEvent(three)).toMatchObject({ state: "read", deliveredAt: expect.any(Number) });
		expect(admit).toHaveBeenCalledTimes(2);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it("waits for the complete tool batch and includes an omitted completed-wait reference", async () => {
		const siblingStarted = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let fixture: Awaited<ReturnType<typeof createAdmissionHarness>>;
		const tools: AgentTool[] = [
			{
				name: "wait_ref",
				label: "Wait reference",
				description: "Stage a completed wait",
				parameters: Type.Object({}),
				execute: async () => {
					const reference = fixture.coordinator.seedEvent("waited", "waited body");
					fixture.coordinator.omitOrdinaryCandidate(reference);
					fixture.harness.session.requestAdmission.stageCompletedWait(reference, fixture.fence);
					return { content: [{ type: "text", text: "waited" }], details: {} };
				},
			},
			{
				name: "sibling",
				label: "Sibling",
				description: "Held sibling",
				parameters: Type.Object({}),
				execute: async () => {
					siblingStarted.resolve();
					await release.promise;
					return { content: [{ type: "text", text: "done" }], details: {} };
				},
			},
		];
		fixture = await createAdmissionHarness({ tools });
		fixtures.push(fixture);
		fixture.harness.session.requestAdmission.bind(fixture.coordinator);
		const snapshot = vi.spyOn(fixture.coordinator, "snapshot");
		const admit = vi.spyOn(fixture.coordinator, "admit");
		const requests: unknown[] = [];
		fixture.harness.setResponses([
			fauxAssistantMessage([fauxToolCall("wait_ref", {}), fauxToolCall("sibling", {})], { stopReason: "toolUse" }),
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("done");
			},
		]);
		const prompt = fixture.harness.session.prompt("run tools");
		await siblingStarted.promise;
		expect(snapshot).toHaveBeenCalledTimes(1);
		expect(fixture.manager.getEntries().flatMap((entry) => readExternalEntry(entry) ?? [])).toEqual([]);
		expect(fixture.harness.faux.state.callCount).toBe(1);
		release.resolve();
		await prompt;
		expect(snapshot).toHaveBeenCalledTimes(2);
		expect(snapshot.mock.calls[1][0].references).toEqual([
			{ recipientIdentity: fixture.fence.mailboxId, eventId: "waited" },
		]);
		expect(
			fixture.manager
				.getEntries()
				.flatMap((entry) => readExternalEntry(entry) ?? [])
				.filter((item) => item.kind === "admission")
				.map((item) => item.eventId),
		).toEqual(["waited"]);
		expect(admit).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(requests[0])).toContain("waited body");
		expect(fixture.harness.faux.state.callCount).toBe(2);
	});

	it("summarizes admitted history for a large candidate without exposing its unread body", async () => {
		const fixture = await createAdmissionHarness({
			models: [{ id: "faux-1", contextWindow: 5000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => ({
						message: { customType: "before-start", content: "UNSENT_SUMMARY_CUSTOM", display: false },
					}));
				},
			],
		});
		fixtures.push(fixture);
		fixture.manager.appendContextEdit(fixture.manager.getBranch()[0].id, {
			content: `OLD_ADMITTED_HISTORY ${"x".repeat(1000)}`,
		});
		fixture.manager.appendMessage(fauxAssistantMessage("old answer"));
		fixture.harness.session.refreshContext();
		fixture.coordinator.seedEvent("large", `UNREAD_SECRET ${"y".repeat(12000)}`);
		fixture.harness.session.requestAdmission.bind(fixture.coordinator);
		const summaries: string[] = [];
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const snapshot = vi.spyOn(fixture.coordinator, "snapshot");
		const targetRequests: unknown[] = [];
		fixture.harness.setResponses([
			async (context) => {
				summaries.push(JSON.stringify(context));
				entered.resolve();
				await release.promise;
				return fauxAssistantMessage("real summary");
			},
			(context) => {
				targetRequests.push(structuredClone(context));
				return fauxAssistantMessage("target response");
			},
		]);
		const prompt = fixture.harness.session.prompt("UNSENT_PROMPT");
		await Promise.race([
			entered.promise,
			prompt.then(() => {
				throw new Error("summary did not start");
			}),
		]);
		const late = fixture.coordinator.seedEvent("summary-late", "late body");
		expect(snapshot).toHaveBeenCalledTimes(1);
		release.resolve();
		await prompt;
		expect(snapshot).toHaveBeenCalledTimes(1);
		expect(fixture.coordinator.inspectEvent(late)?.deliveredAt).toBeNull();
		expect(summaries.length).toBeGreaterThan(0);
		expect(summaries.join(" ")).toContain("OLD_ADMITTED_HISTORY");
		expect(summaries.join(" ")).not.toContain("UNREAD_SECRET");
		expect(summaries.join(" ")).not.toContain("pi.external-admission-candidate.v1");
		expect(fixture.manager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
		expect(JSON.stringify(fixture.manager.buildSessionProjection().messages)).toContain("UNSENT_PROMPT");
		expect(targetRequests).toHaveLength(1);
		expect(JSON.stringify(targetRequests[0])).toContain("UNREAD_SECRET");
		expect(JSON.stringify(targetRequests[0])).toContain("UNSENT_PROMPT");
		expect(JSON.stringify(targetRequests[0])).toContain("UNSENT_SUMMARY_CUSTOM");
		expect(fixture.harness.eventsOfType("request_suppressed")).toHaveLength(0);
	});

	it("uses the physical routed window without exposing unread candidates to the router or summary", async () => {
		const routes: Array<{ reason: string; input: string }> = [];
		const fixture = await createAdmissionHarness({
			models: [
				{ id: "small", contextWindow: 4000, maxTokens: 100 },
				{ id: "large", contextWindow: 50000, maxTokens: 100 },
			],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.registerVirtualModel({
						provider: "router",
						id: "auto",
						name: "Auto",
						contextWindow: 50000,
						route: (request, ctx) => {
							routes.push({ reason: request.reason, input: JSON.stringify(request) });
							return {
								model: ctx.modelRegistry.find("faux", request.reason === "direct" ? "large" : "small")!,
								thinkingLevel: "off",
							};
						},
					});
				},
			],
		});
		fixtures.push(fixture);
		const model = fixture.harness.session.modelRuntime.getModel("router", "auto");
		if (!model) throw new Error("missing virtual model");
		await fixture.harness.session.setModel(model);
		fixture.manager.appendMessage({ role: "user", content: "ROUTED_OLD_HISTORY", timestamp: Date.now() });
		fixture.manager.appendMessage(fauxAssistantMessage("old routed response"));
		fixture.manager.appendMessage({ role: "user", content: "older follow-up", timestamp: Date.now() });
		fixture.manager.appendMessage(fauxAssistantMessage("older answer"));
		fixture.harness.session.refreshContext();
		const event = fixture.coordinator.seedEvent("routed", `ROUTED_SECRET ${"x".repeat(12000)}`);
		fixture.harness.session.requestAdmission.bind(fixture.coordinator);
		const summaries: string[] = [];
		const targets: string[] = [];
		const admit = vi.spyOn(fixture.coordinator, "admit");
		fixture.harness.setResponses([
			(context) => {
				summaries.push(JSON.stringify(context));
				return fauxAssistantMessage("routed summary");
			},
			(context) => {
				summaries.push(JSON.stringify(context));
				return fauxAssistantMessage("routed prefix summary");
			},
			(context) => {
				targets.push(JSON.stringify(context));
				return fauxAssistantMessage("routed target");
			},
		]);
		await fixture.harness.session.prompt("routed prompt");
		expect(routes.filter((route) => route.reason === "user")).toHaveLength(1);
		expect(routes.filter((route) => route.reason === "direct")).toHaveLength(1);
		expect(JSON.stringify(routes)).not.toContain("ROUTED_SECRET");
		expect(summaries.length).toBeGreaterThan(0);
		expect(summaries.join(" ")).toContain("ROUTED_OLD_HISTORY");
		expect(summaries.join(" ")).not.toContain("ROUTED_SECRET");
		expect(targets).toHaveLength(1);
		expect(targets[0]).not.toContain("ROUTED_SECRET");
		expect(targets[0]).toContain("deferred-budget");
		expect(admit).toHaveBeenCalledTimes(1);
		expect(fixture.coordinator.inspectEvent(event)?.state).toBe("pending");
		expect(summaries).toHaveLength(2);
		expect(fixture.harness.faux.state.callCount).toBe(3);
		expect(fixture.harness.eventsOfType("request_suppressed")).toHaveLength(0);
	});

	it("keeps the tool group and polls only one late steering message after held compaction", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let fixture: Awaited<ReturnType<typeof createAdmissionHarness>>;
		const tool: AgentTool = {
			name: "seed_event",
			label: "Seed",
			description: "Seed external event",
			parameters: Type.Object({}),
			execute: async () => {
				fixture.coordinator.seedEvent("continuation", `CONTINUATION_SECRET ${"z".repeat(35000)}`);
				return { content: [{ type: "text", text: "TOOL_RESULT_MARKER" }], details: {} };
			},
		};
		fixture = await createAdmissionHarness({
			models: [{ id: "faux-1", contextWindow: 10000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } },
			tools: [tool],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						expect(JSON.stringify(event.preparation)).not.toContain("CONTINUATION_SECRET");
						entered.resolve();
						await release.promise;
						return {
							compaction: {
								summary: "held summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		fixtures.push(fixture);
		fixture.harness.session.setSteeringMode("one-at-a-time");
		fixture.harness.session.requestAdmission.bind(fixture.coordinator);
		const snapshot = vi.spyOn(fixture.coordinator, "snapshot");
		const requests: unknown[] = [];
		const targetEntered = Promise.withResolvers<void>();
		const targetRelease = Promise.withResolvers<void>();
		fixture.harness.setResponses([
			fauxAssistantMessage(fauxToolCall("seed_event", {}), { stopReason: "toolUse" }),
			async (context) => {
				requests.push(structuredClone(context));
				targetEntered.resolve();
				await targetRelease.promise;
				return fauxAssistantMessage("continuation done");
			},
		]);
		const prompt = fixture.harness.session.prompt("tool prompt");
		await Promise.race([
			entered.promise,
			prompt.then(() => {
				throw new Error("compaction did not start");
			}),
		]);
		fixture.coordinator.seedEvent("late", "late event body");
		await fixture.harness.session.steer("late steering one");
		await fixture.harness.session.steer("late steering two");
		release.resolve();
		await targetEntered.promise;
		expect(fixture.harness.session.pendingMessageCount).toBe(1);
		const aborting = fixture.harness.session.abort();
		targetRelease.resolve();
		await Promise.all([prompt, aborting]);
		const projected = fixture.manager.buildSessionProjection();
		const projection = JSON.stringify(projected.messages);
		const toolCall = fixture.manager
			.getEntries()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "assistant" &&
					entry.message.content.some((block) => block.type === "toolCall" && block.name === "seed_event"),
			);
		const toolResult = fixture.manager
			.getEntries()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "toolResult" &&
					JSON.stringify(entry.message).includes("TOOL_RESULT_MARKER"),
			);
		const lateInput = fixture.manager
			.getEntries()
			.find(
				(entry) =>
					entry.type === "message" &&
					entry.message.role === "user" &&
					JSON.stringify(entry.message.content).includes("late steering one"),
			);
		expect(toolCall).toBeDefined();
		expect(toolResult).toBeDefined();
		expect(lateInput).toBeDefined();
		const projectedIds = projected.entries.map((entry) => entry.sourceEntry.id);
		expect(projectedIds).toContain(toolCall?.id);
		expect(projectedIds).toContain(toolResult?.id);
		expect(projectedIds).toContain(lateInput?.id);
		expect(JSON.stringify(requests[0])).toContain("TOOL_RESULT_MARKER");
		expect(JSON.stringify(requests[0])).toContain("seed_event");
		expect(JSON.stringify(requests[0])).toContain("late steering one");
		expect(JSON.stringify(requests[0])).not.toContain("late steering two");
		expect(projection).toContain("TOOL_RESULT_MARKER");
		expect(projection).toContain("seed_event");
		expect(projection).toContain("late steering one");
		expect(projection).not.toContain("late steering two");
		expect(fixture.harness.session.pendingMessageCount).toBe(1);
		expect(snapshot).toHaveBeenCalledTimes(2);
		expect(
			fixture.coordinator.inspectEvent({ recipientIdentity: fixture.fence.mailboxId, eventId: "late" })?.deliveredAt,
		).toBeNull();
		expect(fixture.harness.faux.state.callCount).toBe(2);
	});

	it("rejects an extension cut that would discard the unsent user and before-start input", async () => {
		let attemptedCut: string | undefined;
		const fixture = await createAdmissionHarness({
			models: [{ id: "faux-1", contextWindow: 3000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 0, keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => ({
						message: { customType: "before-start", content: `UNSENT_CUSTOM ${"a".repeat(1500)}`, display: false },
					}));
					pi.on("session_before_compact", (event) => {
						attemptedCut = event.branchEntries.findLast(
							(entry) => entry.type === "custom_message" && entry.customType === "before-start",
						)?.id;
						if (!attemptedCut) throw new Error("missing custom message");
						return {
							compaction: {
								summary: "unsafe summary",
								firstKeptEntryId: attemptedCut,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
				},
			],
		});
		fixtures.push(fixture);
		fixture.coordinator.seedEvent("large", "p".repeat(20000));
		fixture.harness.session.requestAdmission.bind(fixture.coordinator);
		const requests: unknown[] = [];
		fixture.harness.setResponses([
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("done");
			},
		]);
		await fixture.harness.session.prompt("UNSENT_USER");
		const messages = JSON.stringify(fixture.manager.buildSessionProjection().messages);
		expect(attemptedCut).toBeDefined();
		expect(messages).toContain("UNSENT_USER");
		expect(messages).toContain("UNSENT_CUSTOM");
		expect(fixture.manager.getEntries().some((entry) => entry.type === "compaction")).toBe(false);
		expect(fixture.harness.eventsOfType("compaction_end").at(-1)?.errorMessage).toContain("discard unsent input");
		expect(fixture.harness.faux.state.callCount).toBe(1);
		expect(JSON.stringify(requests[0])).toContain("UNSENT_USER");
		expect(JSON.stringify(requests[0])).toContain("UNSENT_CUSTOM");
	});

	it("clamps compaction before the first unsent input", async () => {
		const fixture = await createAdmissionHarness();
		fixtures.push(fixture);
		const firstUnsentEntryId = fixture.manager.appendMessage({
			role: "user",
			content: "UNSENT INPUT",
			timestamp: Date.now(),
		});
		fixture.manager.appendCustomMessageEntry("before-start", "CUSTOM INPUT", false);
		const preparation = prepareCompaction(
			fixture.manager.getBranch(),
			{ enabled: true, reserveTokens: 0, keepRecentTokens: 1 },
			{ firstUnsentEntryId },
		);
		expect(preparation?.firstKeptEntryId).toBe(firstUnsentEntryId);
		expect(JSON.stringify(preparation?.messagesToSummarize)).not.toContain("UNSENT INPUT");
		expect(JSON.stringify(preparation?.turnPrefixMessages)).not.toContain("UNSENT INPUT");
	});

	it("rejects stale facades, duplicate bindings and foreign references", async () => {
		const fixture = await createAdmissionHarness();
		fixtures.push(fixture);
		const facade = fixture.harness.session.requestAdmission;
		const dispose = facade.bind(fixture.coordinator);
		expect(() => facade.bind(fixture.coordinator)).toThrow("already bound");
		expect(() =>
			facade.stageCompletedWait({ recipientIdentity: "foreign", eventId: "event" }, fixture.fence),
		).toThrow("Invalid");
		dispose();
		const disposeAgain = facade.bind(fixture.coordinator);
		dispose();
		expect(() => facade.bind(fixture.coordinator)).toThrow("already bound");
		disposeAgain();
		fixture.harness.session.retireRuntime("reload");
		expect(() => facade.bind(fixture.coordinator)).toThrow("retired");
	});

	it.each(["suppressed", "snapshot failure", "delivery failure"] as const)(
		"retains omitted completed-wait references after %s",
		async (failure) => {
			const fixture = await createAdmissionHarness();
			fixtures.push(fixture);
			const { coordinator, harness, fence } = fixture;
			const event = coordinator.seedEvent("wait-ref", "PRIVATE_WAIT_BODY");
			coordinator.omitOrdinaryCandidate(event);
			const reference = { recipientIdentity: fence.mailboxId, eventId: "wait-ref" };
			const missing = { recipientIdentity: fence.mailboxId, eventId: "missing-ref" };
			harness.session.requestAdmission.bind(coordinator);
			harness.session.requestAdmission.stageCompletedWait(reference, fence);
			harness.session.requestAdmission.stageCompletedWait(missing, fence);
			corruptCandidates(harness);
			const snapshot = vi.spyOn(coordinator, "snapshot");
			const delivered = vi.spyOn(coordinator, "delivered");
			const admit = vi.spyOn(coordinator, "admit");
			if (failure === "snapshot failure") snapshot.mockRejectedValueOnce(new Error("snapshot failed"));
			if (failure === "delivery failure") delivered.mockRejectedValueOnce(new Error("delivery failed"));
			await harness.session.prompt("first");
			expect(snapshot).toHaveBeenCalledTimes(1);
			expect(snapshot.mock.calls[0][0].references).toEqual([reference, missing]);
			expect(harness.faux.state.callCount).toBe(0);
			expect(admit).not.toHaveBeenCalled();
			harness.session.requestAdmission.stageCompletedWait(reference, fence);
			await harness.session.prompt("second");
			expect(snapshot).toHaveBeenCalledTimes(2);
			expect(snapshot.mock.calls[0][0].references).toEqual([reference, missing]);
			expect(snapshot.mock.calls[1][0].references).toEqual([reference, missing]);
			expect(admit).not.toHaveBeenCalled();
			expect(harness.faux.state.callCount).toBe(0);
			expect(coordinator.inspectEvent(event)?.state).toBe("pending");
			const notices = harness.eventsOfType("request_suppressed");
			expect(JSON.stringify(notices)).not.toContain("PRIVATE_WAIT_BODY");
		},
	);

	it("keeps the captured reference list finite while merging newly staged references", async () => {
		const fixture = await createAdmissionHarness();
		fixtures.push(fixture);
		const { coordinator, harness, fence } = fixture;
		const first = coordinator.seedEvent("first-wait", "first body");
		const second = coordinator.seedEvent("second-wait", "second body");
		coordinator.omitOrdinaryCandidate(first);
		coordinator.omitOrdinaryCandidate(second);
		const one = { recipientIdentity: fence.mailboxId, eventId: first.eventId };
		const two = { recipientIdentity: fence.mailboxId, eventId: second.eventId };
		harness.session.requestAdmission.bind(coordinator);
		harness.session.requestAdmission.stageCompletedWait(one, fence);
		corruptCandidates(harness);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const actualSnapshot = coordinator.snapshot.bind(coordinator);
		const snapshot = vi.spyOn(coordinator, "snapshot").mockImplementationOnce(async (request, signal) => {
			entered.resolve();
			await release.promise;
			return actualSnapshot(request, signal);
		});
		const admit = vi.spyOn(coordinator, "admit");
		const running = harness.session.prompt("first");
		await entered.promise;
		harness.session.requestAdmission.stageCompletedWait(two, fence);
		harness.session.requestAdmission.stageCompletedWait(one, fence);
		expect(snapshot.mock.calls[0][0].references).toEqual([one]);
		release.resolve();
		await running;
		expect(snapshot).toHaveBeenCalledTimes(1);
		expect(coordinator.inspectEvent(second)?.deliveredAt).toBeNull();
		await harness.session.prompt("second");
		expect(snapshot).toHaveBeenCalledTimes(2);
		expect(snapshot.mock.calls[0][0].references).toEqual([one]);
		expect(snapshot.mock.calls[1][0].references).toEqual([one, two]);
		expect(admit).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("does not restore a held request into a retired owner", async () => {
		const fixture = await createAdmissionHarness();
		fixtures.push(fixture);
		const { coordinator, harness, fence } = fixture;
		const event = coordinator.seedEvent("retired-wait", "private body");
		coordinator.omitOrdinaryCandidate(event);
		const facade = harness.session.requestAdmission;
		facade.bind(coordinator);
		facade.stageCompletedWait(event, fence);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const snapshot = vi.spyOn(coordinator, "snapshot").mockImplementationOnce(async () => {
			entered.resolve();
			await release.promise;
			throw new Error("old snapshot failed");
		});
		const admit = vi.spyOn(coordinator, "admit");
		const running = harness.session.prompt("first");
		await entered.promise;
		harness.session.retireRuntime("reload");
		release.resolve();
		await running;
		expect(() => facade.bind(coordinator)).toThrow("retired");
		expect(() => facade.stageCompletedWait(event, fence)).toThrow("stale");
		expect(snapshot).toHaveBeenCalledTimes(1);
		expect(admit).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("does not carry references from an unbound facade into a new binding", async () => {
		const fixture = await createAdmissionHarness();
		fixtures.push(fixture);
		const { coordinator, harness, fence } = fixture;
		const event = coordinator.seedEvent("old-wait", "old body");
		coordinator.omitOrdinaryCandidate(event);
		const facade = harness.session.requestAdmission;
		const dispose = facade.bind(coordinator);
		facade.stageCompletedWait(event, fence);
		corruptCandidates(harness);
		await harness.session.prompt("first");
		dispose();
		facade.bind(coordinator);
		const snapshot = vi.spyOn(coordinator, "snapshot");
		await harness.session.prompt("second");
		expect(snapshot).toHaveBeenCalledTimes(1);
		expect(snapshot.mock.calls[0][0].references).toEqual([]);
		expect(coordinator.inspectEvent(event)?.state).toBe("pending");
	});

	it("persists a known commit after cancellation without selecting or dispatching it", async () => {
		const fixture = await createAdmissionHarness();
		fixtures.push(fixture);
		const event = fixture.coordinator.seedEvent("cancelled", "CANCELLED_BODY");
		fixture.harness.session.requestAdmission.bind(fixture.coordinator);
		const gate = fixture.coordinator.holdNextAdmission();
		const admit = vi.spyOn(fixture.coordinator, "admit");
		const running = fixture.harness.session.prompt("cancel this request");
		await gate.received;
		const root = fixture.manager.getLeafId();
		gate.commit();
		await gate.committed;
		const aborting = fixture.harness.session.abort();
		gate.respond();
		await Promise.all([running, aborting]);
		const result = fixture.coordinator.inspectRequest(admit.mock.calls[0][0].request.requestId)?.result;
		expect(result?.entries).toHaveLength(1);
		expect(fixture.manager.getEntry(result!.entries[0].entryId)).toBeDefined();
		expect(fixture.manager.getLeafId()).toBe(root);
		expect(fixture.coordinator.inspectEvent(event)?.state).toBe("read");
		expect(fixture.coordinator.inspectRequest(admit.mock.calls[0][0].request.requestId)?.suppressed).toBe(true);
		expect(fixture.harness.faux.state.callCount).toBe(0);
	});

	it("does not dispatch or retry after an unknown admission response", async () => {
		const fixture = await createAdmissionHarness();
		fixtures.push(fixture);
		const event = fixture.coordinator.seedEvent("uncertain", "UNCERTAIN_BODY");
		fixture.coordinator.seedMatchingConsumption(event, "uncertain-claim");
		const dispose = fixture.harness.session.requestAdmission.bind(fixture.coordinator);
		const gate = fixture.coordinator.holdNextAdmission();
		const admit = vi.spyOn(fixture.coordinator, "admit");
		const running = fixture.harness.session.prompt("uncertain request");
		await gate.received;
		gate.commit();
		await gate.committed;
		gate.rejectResponse(new Error("response lost"));
		await running;
		expect(admit).toHaveBeenCalledTimes(1);
		expect(fixture.coordinator.inspectEvent(event)?.state).toBe("read");
		expect(fixture.harness.faux.state.callCount).toBe(0);
		expect(fixture.harness.eventsOfType("request_suppressed")).toMatchObject([{ reason: "admission-uncertain" }]);
		expect(fixture.coordinator.inspectConsumption(event)).toBeNull();
		const id = admit.mock.calls[0][0].request.requestId;
		const committed = await fixture.coordinator.lookup(id);
		dispose();
		fixture.harness.session.requestAdmission.bind(fixture.coordinator);
		await fixture.harness.session.requestAdmission.reconcile();
		expect(admit).toHaveBeenCalledTimes(1);
		expect(fixture.harness.faux.state.callCount).toBe(0);
		expect(await fixture.coordinator.lookup(id)).toEqual(committed);
		fixture.harness.setResponses([fauxAssistantMessage("explicit success")]);
		await fixture.harness.session.prompt("explicit later prompt");
		expect(fixture.harness.faux.state.callCount).toBe(1);
		expect(admit).toHaveBeenCalledTimes(1);
		expect(fixture.coordinator.inspectEvent(event)?.state).toBe("read");
	});

	it("reports a missing reference without a body or dispatch", async () => {
		const fixture = await createAdmissionHarness();
		fixtures.push(fixture);
		fixture.harness.session.requestAdmission.bind(fixture.coordinator);
		fixture.harness.session.requestAdmission.stageCompletedWait(
			{ recipientIdentity: fixture.fence.mailboxId, eventId: "missing" },
			fixture.fence,
		);
		const requests: unknown[] = [];
		fixture.harness.setResponses([
			(context) => {
				requests.push(structuredClone(context));
				return fauxAssistantMessage("done");
			},
		]);
		await fixture.harness.session.prompt("start");
		expect(fixture.harness.eventsOfType("request_suppressed")).toHaveLength(0);
		expect(JSON.stringify(requests[0])).toContain("status=unavailable");
		expect(JSON.stringify(requests[0])).toContain("missing");
		expect(fixture.harness.faux.state.callCount).toBe(1);
		expect(fixture.manager.getEntries().flatMap((entry) => readExternalEntry(entry) ?? [])).toEqual([]);
	});
});
