import { appendFileSync, readFileSync } from "node:fs";
import { fauxAssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { prepareBranchEntries, prepareCompaction } from "../../src/core/compaction/index.ts";
import {
	ACTIVE_SELECTION,
	ADMISSION_MESSAGE,
	EXTERNAL_HISTORY,
	EXTERNAL_RECORD,
} from "../../src/core/durable-records.ts";
import { readExternalEntry } from "../../src/core/external-event-records.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	ADMITTED_BODY,
	admission,
	canonical,
	PENDING_BODY,
	savedFixture,
	selectSyntheticAdmission,
} from "../helpers/external-events.ts";
import { assistantMsg, userMsg } from "../utilities.ts";
import { createHarness } from "./harness.ts";

function seedProjection(f: ReturnType<typeof savedFixture>) {
	const pending = f.manager.appendEntryOnce(canonical("pending"), f.selected);
	f.manager.branch(pending.entryId);
	f.manager.appendMessage(userMsg("after canonical"));
	const anchor = f.manager.getLeafId();
	const admitted = selectSyntheticAdmission(f.manager, admission(canonical("admitted", "OTHER_CANONICAL"), anchor));
	f.manager.appendMessage(assistantMsg("after admission"));
	for (let i = 0; i < 4; i++) {
		f.manager.appendMessage(userMsg(`ordinary user ${i} ${"x".repeat(100)}`));
		f.manager.appendMessage(assistantMsg(`ordinary assistant ${i} ${"y".repeat(100)}`));
	}
	f.manager.appendMessage(userMsg("recent user boundary"));
	return { pending, admitted };
}

const reserved = [EXTERNAL_RECORD, EXTERNAL_HISTORY, ACTIVE_SELECTION, ADMISSION_MESSAGE];

describe("combined external event proof", () => {
	it("keeps delivery, refresh, compaction, repair and copy isolated across reopen and branches", async () => {
		const f = savedFixture();
		const event = canonical("combined");
		try {
			for (let i = 0; i < 4; i++) {
				f.manager.appendMessage(userMsg(`older ${i} ${"x".repeat(200)}`));
				f.manager.appendMessage(assistantMsg(`answer ${i} ${"y".repeat(200)}`));
			}
			f.manager.appendMessage(userMsg("older selected sibling"));
			const older = f.manager.appendMessage(assistantMsg("older selected response"));
			f.manager.branch(f.root);
			const delivery = f.manager.appendMessage(userMsg("delivery sibling"));
			f.manager.branch(older);
			const first = f.manager.appendEntryOnce(event, delivery);
			const retry = f.manager.appendEntryOnce(event, delivery);
			expect(retry.entryId).toBe(first.entryId);
			const manager = SessionManager.open(f.manager.getSessionFile()!);
			expect(manager.getLeafId()).toBe(older);
			const harness = await createHarness({
				sessionManager: manager,
				settings: { compaction: { keepRecentTokens: 1 } },
			});
			try {
				expect(harness.faux.state.callCount).toBe(0);
				const summaryRequests: TranscriptContext[] = [];
				const stream = harness.session.agent.streamFunction;
				if (!stream) throw new Error("Missing faux stream");
				harness.session.agent.streamFunction = (model, context, options) => {
					summaryRequests.push(structuredClone(context));
					return stream(model, context, options);
				};
				const cards = () => harness.session.getExternalEventView().filter((item) => item.type === "external_event");
				const countRecords = (kind: string) =>
					manager
						.getEntries()
						.map(readExternalEntry)
						.filter((record) => record?.kind === kind);
				expect(countRecords("canonical")).toHaveLength(1);
				expect(cards()).toMatchObject([{ location: "shelf" }]);
				harness.setResponses([fauxAssistantMessage("older summary"), fauxAssistantMessage("older prefix")]);
				await harness.session.compact();
				expect(summaryRequests.length).toBeGreaterThan(0);
				expect(cards()).toMatchObject([{ location: "shelf" }]);
				const callsBeforeRefresh = harness.faux.state.callCount;
				const startsBeforeRefresh = harness.eventsOfType("agent_start").length;
				const disposition = {
					recipientIdentity: event.recipientIdentity,
					eventId: event.eventId,
					state: "pending" as const,
					expiresAt: Date.now() - 1,
					reason: null,
				};
				const sessionId = manager.getSessionId();
				harness.session.refreshExternalEvents({ sessionId, revision: 1, verified: true, events: [disposition] });
				expect(cards()).toMatchObject([{ state: "expired", verified: false }]);
				harness.session.refreshExternalEvents({
					sessionId,
					revision: 2,
					verified: true,
					events: [{ ...disposition, state: "dropped", reason: "dropped" }],
				});
				expect(cards()).toMatchObject([{ state: "dropped", verified: true }]);
				harness.session.refreshExternalEvents({ sessionId, revision: 3, verified: false });
				expect(cards()).toMatchObject([{ state: "dropped", verified: false }]);
				harness.session.refreshExternalEvents({
					sessionId,
					revision: 4,
					verified: true,
					events: [{ ...disposition, expiresAt: null }],
				});
				expect(cards()).toMatchObject([{ state: "pending", verified: true }]);
				expect(harness.faux.state.callCount - callsBeforeRefresh).toBe(0);
				expect(harness.eventsOfType("agent_start").length - startsBeforeRefresh).toBe(0);
				const admissionRecord = admission(event, delivery);
				const admitted = selectSyntheticAdmission(manager, admissionRecord);
				for (let i = 0; i < 4; i++) {
					manager.appendMessage(userMsg(`admitted history ${i} ${"z".repeat(200)}`));
					manager.appendMessage(assistantMsg(`response ${i} ${"q".repeat(200)}`));
				}
				const admittedLeaf = manager.getLeafId()!;
				await harness.session.navigateTree(admittedLeaf);
				expect(cards()).toMatchObject([{ location: "inline", state: "admitted" }]);
				expect(JSON.stringify(manager.buildSessionContext().messages)).toContain(ADMITTED_BODY);
				expect(JSON.stringify(prepareBranchEntries(manager.getBranch(), 0).messages)).toContain(ADMITTED_BODY);
				const sibling = manager.appendMessage(userMsg("another admitted leaf"));
				await harness.session.navigateTree(older);
				const reopened = SessionManager.open(manager.getSessionFile()!);
				const repairCalls = harness.faux.state.callCount;
				const repairStarts = harness.eventsOfType("agent_start").length;
				expect(reopened.appendEntryOnce(admissionRecord, delivery).entryId).toBe(admitted);
				expect(reopened.getLeafId()).toBe(older);
				expect(JSON.stringify(reopened.buildSessionContext().messages)).not.toContain(ADMITTED_BODY);
				expect(harness.faux.state.callCount - repairCalls).toBe(0);
				expect(harness.eventsOfType("agent_start").length - repairStarts).toBe(0);
				await harness.session.navigateTree(sibling);
				const priorSummaryCount = summaryRequests.length;
				harness.setResponses([fauxAssistantMessage("admitted summary"), fauxAssistantMessage("admitted prefix")]);
				await harness.session.compact();
				expect(summaryRequests.length).toBeGreaterThan(priorSummaryCount);
				expect(JSON.stringify(summaryRequests.slice(priorSummaryCount))).toContain(ADMITTED_BODY);
				expect(cards()).toHaveLength(0);
				expect((await harness.session.navigateTree(admitted)).editorText).toBeUndefined();
				const copyCalls = harness.faux.state.callCount;
				const copyStarts = harness.eventsOfType("agent_start").length;
				const pathCopyManager = SessionManager.open(manager.getSessionFile()!);
				const pathCopy = SessionManager.open(pathCopyManager.createBranchedSession(admitted)!);
				expect(readFileSync(pathCopy.getSessionFile()!, "utf8")).not.toContain(PENDING_BODY);
				expect(JSON.stringify(pathCopy.buildSessionContext().messages)).toContain(ADMITTED_BODY);
				const destination = SessionManager.forkFrom(manager.getSessionFile()!, f.directory, f.directory);
				const bytes = readFileSync(destination.getSessionFile()!, "utf8");
				expect(bytes).not.toContain(PENDING_BODY);
				expect(bytes).not.toContain('"kind":"admission"');
				expect(bytes).not.toContain('"kind":"canonical"');
				expect(
					destination
						.getEntries()
						.map(readExternalEntry)
						.find((record) => record?.kind === "inherited"),
				).toMatchObject({ origin: { sessionId, entryId: admitted }, copiedFrom: { sessionId, entryId: admitted } });
				expect(JSON.stringify(destination.buildSessionContext().messages)).toContain(ADMITTED_BODY);
				expect(harness.faux.state.callCount - copyCalls).toBe(0);
				expect(harness.eventsOfType("agent_start").length - copyStarts).toBe(0);
				expect(countRecords("canonical")).toHaveLength(1);
				expect(countRecords("admission")).toHaveLength(1);
				expect(summaryRequests.every((request) => !JSON.stringify(request).includes(PENDING_BODY))).toBe(true);
			} finally {
				harness.cleanup();
			}
		} finally {
			f.cleanup();
		}
	});
});

describe("selected external history projection", () => {
	it("isolates pending bodies from both summary preparations and repeated compaction", () => {
		const f = savedFixture();
		try {
			const { admitted } = seedProjection(f);
			const settings = { enabled: true, reserveTokens: 16, keepRecentTokens: 1 };
			const prepared = prepareCompaction(f.manager.getBranch(), settings);
			expect(prepared).toBeDefined();
			const summaryInput = JSON.stringify([...prepared!.messagesToSummarize, ...prepared!.turnPrefixMessages]);
			expect(summaryInput).not.toContain(PENDING_BODY);
			expect(summaryInput).toContain(ADMITTED_BODY);
			const branch = f.manager.getBranch();
			expect(branch.findIndex((entry) => entry.id === admitted)).toBeLessThan(
				branch.findIndex((entry) => entry.id === prepared!.firstKeptEntryId),
			);
			const branchInput = JSON.stringify(prepareBranchEntries(branch, 0).messages);
			expect(branchInput).not.toContain(PENDING_BODY);
			expect(branchInput).toContain(ADMITTED_BODY);
			f.manager.appendCompaction("summary of admitted history", prepared!.firstKeptEntryId, prepared!.tokensBefore);
			f.manager.appendMessage(userMsg("more history"));
			f.manager.appendMessage(assistantMsg("another response"));
			const next = prepareCompaction(f.manager.getBranch(), settings);
			expect(next).toBeDefined();
			expect(JSON.stringify(next)).not.toContain(PENDING_BODY);
			expect(JSON.stringify(f.manager.buildSessionContext().messages)).not.toContain(PENDING_BODY);
			f.manager.appendCompaction("retain none", null, 100);
			expect(JSON.stringify(f.manager.buildSessionContext().messages)).not.toContain(PENDING_BODY);
			expect(JSON.stringify(f.manager.buildSessionContext().messages)).not.toContain(ADMITTED_BODY);
		} finally {
			f.cleanup();
		}
	});

	for (const operation of ["prompt", "compaction", "branch summary"] as const) {
		it(`sends admitted but not canonical content to the faux provider for ${operation}`, async () => {
			const f = savedFixture();
			seedProjection(f);
			const hookInputs: string[] = [];
			const harness = await createHarness({
				sessionManager: f.manager,
				settings: { compaction: { keepRecentTokens: 1 } },
				extensionFactories: [
					(pi) => {
						pi.on("session_before_compact", (event) => {
							hookInputs.push(
								JSON.stringify([
									...event.preparation.messagesToSummarize,
									...event.preparation.turnPrefixMessages,
								]),
							);
						});
						pi.on("session_before_tree", (event) => {
							hookInputs.push(
								JSON.stringify(prepareBranchEntries(event.preparation.entriesToSummarize, 0).messages),
							);
						});
					},
				],
			});
			try {
				expect(harness.faux.state.callCount).toBe(0);
				const captured: TranscriptContext[] = [];
				const original = harness.session.agent.streamFunction;
				if (!original) throw new Error("The suite harness must provide its faux stream function");
				harness.session.agent.streamFunction = (model, context, options) => {
					captured.push(structuredClone(context));
					return original(model, context, options);
				};
				harness.setResponses([fauxAssistantMessage("response")]);
				if (operation === "prompt") await harness.session.prompt("ordinary prompt");
				else if (operation === "compaction") await harness.session.compact();
				else await harness.session.navigateTree(f.selected, { summarize: true });
				expect(captured).toHaveLength(1);
				expect(JSON.stringify(captured)).not.toContain(PENDING_BODY);
				expect(JSON.stringify(captured)).toContain(ADMITTED_BODY);
				if (operation !== "prompt") {
					expect(hookInputs).toHaveLength(1);
					expect(hookInputs[0]).not.toContain(PENDING_BODY);
					expect(hookInputs[0]).toContain(ADMITTED_BODY);
				}
				expect(JSON.stringify(f.manager.getEntries())).toContain(PENDING_BODY);
			} finally {
				harness.cleanup();
				f.cleanup();
			}
		});
	}
});

describe("external event tree navigation", () => {
	it("selects canonical, admission and inherited records without editing or starting a turn", async () => {
		const f = savedFixture();
		const event = canonical();
		const canonicalId = f.manager.appendEntryOnce(event, f.root).entryId;
		const admissionId = f.manager.appendEntryOnce(admission(event, f.selected), f.selected).entryId;
		const historyId = "history-navigation";
		const history = {
			type: "custom",
			id: historyId,
			parentId: f.selected,
			timestamp: new Date().toISOString(),
			customType: EXTERNAL_HISTORY,
			data: {
				...event,
				kind: "inherited",
				envelope: ADMITTED_BODY,
				origin: {
					sessionId: "source",
					entryId: "entry",
					requestId: "request",
					instanceId: "instance",
					epoch: 0,
					branchAnchor: null,
				},
				copiedFrom: { sessionId: "source", entryId: "entry" },
			},
		};
		appendFileSync(f.manager.getSessionFile()!, `${JSON.stringify(history)}\n`);
		const manager = SessionManager.open(f.manager.getSessionFile()!);
		const harness = await createHarness({ sessionManager: manager });
		try {
			for (const id of [canonicalId, admissionId, historyId]) {
				const result = await harness.session.navigateTree(id);
				expect(result.cancelled).toBe(false);
				expect(result.editorText).toBeUndefined();
				expect(harness.session.getUserMessagesForForking().some((item) => item.entryId === id)).toBe(false);
				expect(manager.getEntry(id)?.type).toBe("custom");
				if (id === canonicalId) expect(JSON.stringify(harness.session.messages)).not.toContain(PENDING_BODY);
				else expect(JSON.stringify(harness.session.messages)).toContain(ADMITTED_BODY);
			}
			manager.branch(f.selected);
			const ordinaryId = manager.appendMessage(userMsg("editable ordinary"));
			const customId = manager.appendCustomMessageEntry("ordinary-extension", "editable custom", true);
			expect((await harness.session.navigateTree(ordinaryId)).editorText).toBe("editable ordinary");
			expect((await harness.session.navigateTree(customId)).editorText).toBe("editable custom");
			expect(harness.faux.state.callCount).toBe(0);
		} finally {
			harness.cleanup();
			f.cleanup();
		}
	});
});

describe("external event view refresh", () => {
	it("refreshes expiry, disconnect and reconnect without writes or model activity", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const f = savedFixture();
		const event = canonical();
		f.manager.appendEntryOnce(event, f.root);
		const harness = await createHarness({ sessionManager: f.manager });
		try {
			const session = harness.session;
			const sessionId = f.manager.getSessionId();
			const pending = {
				recipientIdentity: event.recipientIdentity,
				eventId: event.eventId,
				state: "pending" as const,
				expiresAt: 1000,
				reason: null,
			};
			const dropped = { ...pending, state: "dropped" as const, reason: "dropped by service" };
			const bytes = readFileSync(f.manager.getSessionFile()!);
			const leaf = f.manager.getLeafId();
			const messages = session.messages;
			const calls = harness.faux.state.callCount;
			const card = () => {
				const cards = session.getExternalEventView().filter((item) => item.type === "external_event");
				expect(cards).toHaveLength(1);
				return cards[0];
			};
			expect(session.refreshExternalEvents({ sessionId, revision: 1, verified: true, events: [pending] })).toBe(
				true,
			);
			expect(card()).toMatchObject({ state: "pending", verified: true });
			await vi.advanceTimersByTimeAsync(1000);
			expect(card()).toMatchObject({ state: "expired", verified: false });
			expect(harness.eventsOfType("external_events_changed").length).toBeGreaterThan(1);
			session.refreshExternalEvents({ sessionId, revision: 3, verified: false });
			expect(session.refreshExternalEvents({ sessionId, revision: 2, verified: true, events: [pending] })).toBe(
				false,
			);
			expect(card().verified).toBe(false);
			session.refreshExternalEvents({ sessionId, revision: 4, verified: true, events: [dropped] });
			expect(card()).toMatchObject({ state: "dropped", verified: true });
			session.refreshExternalEvents({ sessionId, revision: 5, verified: true, events: [] });
			expect(card()).toMatchObject({ state: "unverified", verified: false });
			expect(() => session.refreshExternalEvents({ sessionId: "other", revision: 6, verified: false })).toThrow();
			expect(readFileSync(f.manager.getSessionFile()!)).toEqual(bytes);
			expect(f.manager.getLeafId()).toBe(leaf);
			expect(session.messages).toBe(messages);
			expect(harness.faux.state.callCount).toBe(calls);
			expect(harness.eventsOfType("agent_start")).toHaveLength(0);
			expect(
				f.manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === EXTERNAL_RECORD),
			).toHaveLength(1);
		} finally {
			harness.cleanup();
			f.cleanup();
			vi.useRealTimers();
		}
	});

	it("re-reads appended records and starts reopened sessions unverified", async () => {
		const f = savedFixture();
		const harness = await createHarness({ sessionManager: f.manager });
		try {
			const beforeMessages = harness.session.messages;
			f.manager.appendEntryOnce(canonical(), f.root);
			const bytes = readFileSync(f.manager.getSessionFile()!);
			expect(harness.session.refreshExternalEvents()).toBe(true);
			expect(harness.session.getExternalEventView().filter((item) => item.type === "external_event")).toMatchObject([
				{ state: "unverified", verified: false },
			]);
			expect(readFileSync(f.manager.getSessionFile()!)).toEqual(bytes);
			expect(harness.session.messages).toBe(beforeMessages);
			expect(harness.faux.state.callCount).toBe(0);
			const reopened = await createHarness({ sessionManager: SessionManager.open(f.manager.getSessionFile()!) });
			try {
				expect(
					reopened.session.getExternalEventView().filter((item) => item.type === "external_event"),
				).toMatchObject([{ state: "unverified", verified: false }]);
			} finally {
				reopened.cleanup();
			}
			harness.session.dispose();
			expect(() => harness.session.refreshExternalEvents()).toThrow(/disposed/i);
			expect(() => harness.session.getExternalEventView()).toThrow(/disposed/i);
		} finally {
			harness.cleanup();
			f.cleanup();
		}
	});
});

describe("reserved external infrastructure ingestion", () => {
	for (const customType of reserved) {
		for (const mode of ["nextTurn", "steer", "followUp", "trigger", "context"] as const) {
			it(`rejects ${customType} before ${mode} delivery`, async () => {
				const f = savedFixture();
				const harness = await createHarness({ sessionManager: f.manager });
				try {
					const bytes = readFileSync(f.manager.getSessionFile()!);
					if (mode === "steer" || mode === "followUp")
						vi.spyOn(harness.session, "isStreaming", "get").mockReturnValue(true);
					const options =
						mode === "trigger"
							? { triggerTurn: true }
							: mode === "context"
								? { triggerTurn: false }
								: { deliverAs: mode };
					await expect(
						harness.session.sendCustomMessage({ customType, content: "reserved body", display: false }, options),
					).rejects.toThrow(/reserved/i);
					expect(harness.session.pendingMessageCount).toBe(0);
					const queues = harness.session as unknown as {
						_pendingNextTurnMessages: readonly unknown[];
						_pendingCustomMessages: readonly unknown[];
					};
					expect(queues._pendingNextTurnMessages).toHaveLength(0);
					expect(queues._pendingCustomMessages).toHaveLength(0);
					expect(harness.session.agent.hasQueuedMessages()).toBe(false);
					expect(harness.faux.state.callCount).toBe(0);
					expect(harness.eventsOfType("agent_start")).toHaveLength(0);
					expect(readFileSync(f.manager.getSessionFile()!)).toEqual(bytes);
				} finally {
					vi.restoreAllMocks();
					harness.cleanup();
					f.cleanup();
				}
			});
		}
		it(`rejects ${customType} returned by before_agent_start`, async () => {
			const f = savedFixture();
			const harness = await createHarness({
				sessionManager: f.manager,
				extensionFactories: [
					(pi) => {
						pi.on("before_agent_start", () => ({
							message: { customType, content: "reserved body", display: false },
						}));
					},
				],
			});
			try {
				const bytes = readFileSync(f.manager.getSessionFile()!);
				await expect(harness.session.prompt("hello")).rejects.toThrow(/reserved/i);
				expect(harness.faux.state.callCount).toBe(0);
				expect(harness.eventsOfType("agent_start")).toHaveLength(0);
				expect(readFileSync(f.manager.getSessionFile()!)).toEqual(bytes);
			} finally {
				harness.cleanup();
				f.cleanup();
			}
		});
	}
});
