import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildExternalEventDisplay, type ExternalEventViewState } from "../src/core/external-event-projection.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	ADMITTED_BODY,
	admission,
	canonical,
	PENDING_BODY,
	savedFixture,
	selectSyntheticAdmission,
} from "./helpers/external-events.ts";
import { assistantMsg } from "./utilities.ts";

const unverified: ExternalEventViewState = { revision: -1, verified: false, dispositions: new Map() };

function project(manager: SessionManager, state = unverified) {
	const before = readFileSync(manager.getSessionFile()!);
	const leaf = manager.getLeafId();
	const messages = manager.buildSessionContext().messages;
	const result = buildExternalEventDisplay({
		allEntries: manager.getEntries(),
		activeBranchEntries: manager.getBranch(),
		visibleEntries: manager.buildContextEntries(),
		state,
		now: 0,
	});
	expect(readFileSync(manager.getSessionFile()!)).toEqual(before);
	expect(manager.getLeafId()).toBe(leaf);
	expect(manager.buildSessionContext().messages).toEqual(messages);
	return result.filter((item) => item.type === "external_event");
}

describe("logical external display projection", () => {
	it("keeps an off-branch pre-compaction canonical visible exactly once", () => {
		const f = savedFixture();
		try {
			const event = canonical();
			f.manager.appendEntryOnce(event, f.root);
			f.manager.branch(f.selected);
			f.manager.appendCompaction("ordinary summary", null, 100);
			const cards = project(f.manager);
			expect(cards).toHaveLength(1);
			expect(cards[0].key).toBe('["recipient","event"]');
			expect(cards[0].location).toBe("shelf");
			expect(cards[0].record.envelope).toContain(PENDING_BODY);
			expect(JSON.stringify(f.manager.buildSessionContext().messages)).not.toContain(PENDING_BODY);
		} finally {
			f.cleanup();
		}
	});

	it("places the latest selected admission inline and uses its exact envelope", () => {
		const f = savedFixture();
		try {
			const event = canonical();
			const canonicalId = f.manager.appendEntryOnce(event, f.root).entryId;
			const first = selectSyntheticAdmission(f.manager, admission(event, f.selected, "one"));
			const second = selectSyntheticAdmission(f.manager, {
				...admission(event, first, "two"),
				envelope: `${ADMITTED_BODY} second`,
			});
			f.manager.appendMessage(assistantMsg("after"));
			const cards = project(f.manager);
			expect(cards).toHaveLength(1);
			expect(cards[0]).toMatchObject({
				sourceEntryId: second,
				canonicalEntryId: canonicalId,
				state: "admitted",
				verified: true,
				location: "inline",
			});
			expect(cards[0].record.envelope).toBe(`${ADMITTED_BODY} second`);
		} finally {
			f.cleanup();
		}
	});

	it("renders inherited history inline without a canonical", () => {
		const f = savedFixture();
		try {
			const history = {
				type: "custom" as const,
				id: "history",
				parentId: f.selected,
				timestamp: new Date(0).toISOString(),
				customType: "pi.external-history.v1",
				data: {
					version: 1,
					kind: "inherited",
					recipientIdentity: "recipient",
					eventId: "event",
					envelope: ADMITTED_BODY,
					provenance: null,
					origin: {
						sessionId: "source",
						entryId: "original",
						requestId: "request",
						instanceId: "instance",
						epoch: 0,
						branchAnchor: null,
					},
					copiedFrom: { sessionId: "source", entryId: "original" },
				},
			};
			const bytes = readFileSync(f.manager.getSessionFile()!);
			const leaf = f.manager.getLeafId();
			const messages = f.manager.buildSessionContext().messages;
			const entries = [...f.manager.getEntries(), history];
			const snapshot = structuredClone(entries);
			const result = buildExternalEventDisplay({
				allEntries: entries,
				activeBranchEntries: entries,
				visibleEntries: entries,
				state: unverified,
				now: 0,
			});
			expect(result.filter((item) => item.type === "external_event")).toMatchObject([
				{ sourceEntryId: "history", state: "inherited", location: "inline", record: { envelope: ADMITTED_BODY } },
			]);
			expect(entries).toEqual(snapshot);
			expect(readFileSync(f.manager.getSessionFile()!)).toEqual(bytes);
			expect(f.manager.getLeafId()).toBe(leaf);
			expect(f.manager.buildSessionContext().messages).toEqual(messages);
		} finally {
			f.cleanup();
		}
	});

	it("keeps selected admission authoritative over a contradictory disposition", () => {
		const f = savedFixture();
		try {
			const event = canonical();
			f.manager.appendEntryOnce(event, f.root);
			selectSyntheticAdmission(f.manager, admission(event, f.selected));
			const key = JSON.stringify([event.recipientIdentity, event.eventId]);
			const state: ExternalEventViewState = {
				revision: 1,
				verified: true,
				dispositions: new Map([
					[
						key,
						{
							recipientIdentity: event.recipientIdentity,
							eventId: event.eventId,
							state: "dropped",
							expiresAt: null,
							reason: "remote",
						},
					],
				]),
			};
			expect(project(f.manager, state)).toMatchObject([
				{ state: "admitted", verified: true, reason: null, location: "inline" },
			]);
		} finally {
			f.cleanup();
		}
	});

	it("renders an admission without a canonical and keeps recipients separate", () => {
		const f = savedFixture();
		try {
			const event = canonical();
			const id = selectSyntheticAdmission(f.manager, admission(event, f.selected));
			f.manager.appendEntryOnce({ ...event, recipientIdentity: "other" }, f.root);
			const cards = project(f.manager);
			expect(cards).toHaveLength(2);
			expect(cards.find((card) => card.sourceEntryId === id)).toMatchObject({
				state: "admitted",
				location: "inline",
			});
			expect(new Set(cards.map((card) => card.key)).size).toBe(2);
		} finally {
			f.cleanup();
		}
	});

	it("does not revive a selected admission hidden by compaction", () => {
		const f = savedFixture();
		try {
			const event = canonical();
			const canonicalId = f.manager.appendEntryOnce(event, f.selected).entryId;
			f.manager.branch(canonicalId);
			const id = selectSyntheticAdmission(f.manager, admission(event, canonicalId));
			f.manager.appendMessage(assistantMsg("after"));
			f.manager.appendCompaction("summarized", null, 100);
			const visible = [f.manager.getEntry(canonicalId)!, ...f.manager.buildContextEntries()];
			const state: ExternalEventViewState = {
				revision: 1,
				verified: true,
				dispositions: new Map([
					[
						JSON.stringify([event.recipientIdentity, event.eventId]),
						{
							recipientIdentity: event.recipientIdentity,
							eventId: event.eventId,
							state: "pending",
							expiresAt: null,
							reason: null,
						},
					],
				]),
			};
			const bytes = readFileSync(f.manager.getSessionFile()!);
			const leaf = f.manager.getLeafId();
			const messages = f.manager.buildSessionContext().messages;
			const result = buildExternalEventDisplay({
				allEntries: f.manager.getEntries(),
				activeBranchEntries: f.manager.getBranch(),
				visibleEntries: visible,
				state,
				now: 0,
			});
			expect(result.filter((item) => item.type === "external_event")).toHaveLength(0);
			expect(f.manager.getEntry(id)).toBeDefined();
			expect(readFileSync(f.manager.getSessionFile()!)).toEqual(bytes);
			expect(f.manager.getLeafId()).toBe(leaf);
			expect(f.manager.buildSessionContext().messages).toEqual(messages);
		} finally {
			f.cleanup();
		}
	});

	it("marks a visible canonical read on another branch independent of remote state", () => {
		const f = savedFixture();
		try {
			const event = canonical();
			const canonicalId = f.manager.appendEntryOnce(event, f.root).entryId;
			selectSyntheticAdmission(f.manager, admission(event, f.root));
			f.manager.branch(canonicalId);
			f.manager.appendMessage(assistantMsg("sibling"));
			const key = JSON.stringify([event.recipientIdentity, event.eventId]);
			const conflicting: ExternalEventViewState = {
				revision: 1,
				verified: true,
				dispositions: new Map([
					[
						key,
						{
							recipientIdentity: event.recipientIdentity,
							eventId: event.eventId,
							state: "pending",
							expiresAt: null,
							reason: null,
						},
					],
				]),
			};
			const reopened = SessionManager.open(f.manager.getSessionFile()!);
			for (const state of [unverified, conflicting]) {
				const cards = project(reopened, state);
				expect(cards).toHaveLength(1);
				expect(cards[0]).toMatchObject({
					state: "read",
					verified: true,
					location: "shelf",
					reason: "Admitted on another branch; this view does not admit it",
				});
				expect(JSON.stringify(f.manager.buildSessionContext().messages)).not.toContain(ADMITTED_BODY);
			}
		} finally {
			f.cleanup();
		}
	});

	it("coalesces retries across reopen and keeps root-null pending visible", () => {
		const f = savedFixture();
		try {
			const event = canonical();
			const first = f.manager.appendEntryOnce(event, f.root);
			expect(f.manager.appendEntryOnce(event, f.root).entryId).toBe(first.entryId);
			f.manager.resetLeaf();
			const reopened = SessionManager.open(f.manager.getSessionFile()!);
			expect(reopened.getLeafId()).toBeNull();
			expect(reopened.getEntries().filter((entry) => entry.id === first.entryId)).toHaveLength(1);
			expect(project(reopened)).toMatchObject([{ key: '["recipient","event"]', location: "shelf" }]);
			expect(reopened.buildSessionContext().messages).toEqual([]);
		} finally {
			f.cleanup();
		}
	});

	it("never inserts a canonical between ordinary entries and preserves input ordering", () => {
		const f = savedFixture();
		try {
			const id = f.manager.appendEntryOnce(canonical(), f.selected).entryId;
			f.manager.branch(id);
			f.manager.appendMessage(assistantMsg("after canonical"));
			const entries = f.manager.getBranch();
			const before = readFileSync(f.manager.getSessionFile()!);
			const leaf = f.manager.getLeafId();
			const messages = f.manager.buildSessionContext().messages;
			const result = buildExternalEventDisplay({
				allEntries: f.manager.getEntries(),
				activeBranchEntries: entries,
				visibleEntries: entries,
				state: unverified,
				now: 0,
			});
			expect(result.at(-1)).toMatchObject({ type: "external_event", location: "shelf" });
			expect(result.filter((item) => item.type === "entry").map((item) => item.entry.id)).toEqual(
				entries.filter((entry) => entry.id !== id).map((entry) => entry.id),
			);
			expect(readFileSync(f.manager.getSessionFile()!)).toEqual(before);
			expect(f.manager.getLeafId()).toBe(leaf);
			expect(f.manager.buildSessionContext().messages).toEqual(messages);
		} finally {
			f.cleanup();
		}
	});

	it("derives disposition and conservative expiry without admitting content", () => {
		const f = savedFixture();
		try {
			const event = canonical();
			f.manager.appendEntryOnce(event, f.root);
			const key = JSON.stringify([event.recipientIdentity, event.eventId]);
			for (const state of ["pending", "read", "expired", "dropped"] as const) {
				const snapshot: ExternalEventViewState = {
					revision: 1,
					verified: true,
					dispositions: new Map([
						[
							key,
							{
								recipientIdentity: event.recipientIdentity,
								eventId: event.eventId,
								state,
								expiresAt: null,
								reason: "reason",
							},
						],
					]),
				};
				expect(project(f.manager, snapshot)).toMatchObject([{ state, verified: true, reason: "reason" }]);
			}
			const expired: ExternalEventViewState = {
				revision: 2,
				verified: true,
				dispositions: new Map([
					[
						key,
						{
							recipientIdentity: event.recipientIdentity,
							eventId: event.eventId,
							state: "pending",
							expiresAt: 0,
							reason: null,
						},
					],
				]),
			};
			expect(project(f.manager, expired)).toMatchObject([{ state: "expired", verified: false }]);
			expect(project(f.manager, { ...expired, verified: false })).toMatchObject([
				{ state: "expired", verified: false },
			]);
			expect(project(f.manager, { revision: 3, verified: true, dispositions: new Map() })).toMatchObject([
				{ state: "unverified", verified: false },
			]);
		} finally {
			f.cleanup();
		}
	});

	it("throws on malformed reserved metadata rather than rendering it as ordinary", () => {
		const f = savedFixture();
		try {
			const invalid = {
				type: "custom" as const,
				id: "bad",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				customType: "pi.external-record.v1",
				data: { version: 99 },
			};
			const bytes = readFileSync(f.manager.getSessionFile()!);
			const leaf = f.manager.getLeafId();
			const messages = f.manager.buildSessionContext().messages;
			expect(() =>
				buildExternalEventDisplay({
					allEntries: [invalid],
					activeBranchEntries: [],
					visibleEntries: [invalid],
					state: unverified,
					now: 0,
				}),
			).toThrow();
			expect(readFileSync(f.manager.getSessionFile()!)).toEqual(bytes);
			expect(f.manager.getLeafId()).toBe(leaf);
			expect(f.manager.buildSessionContext().messages).toEqual(messages);
		} finally {
			f.cleanup();
		}
	});
});
