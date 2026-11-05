import { appendFileSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACTIVE_SELECTION, EXTERNAL_RECORD } from "../src/core/durable-records.ts";
import {
	ADMISSION_MESSAGE,
	decodeExternalHistory,
	EXTERNAL_HISTORY,
	externalEntryToMessage,
	externalEventKey,
	readExternalEntry,
} from "../src/core/external-event-records.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	ADMITTED_BODY,
	admission,
	canonical,
	PENDING_BODY,
	savedFixture,
	selectSyntheticAdmission,
} from "./helpers/external-events.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

const valid = {
	version: 1 as const,
	kind: "inherited" as const,
	recipientIdentity: "recipient",
	eventId: "event",
	envelope: "immutable",
	provenance: { sender: { identity: "sender" } },
	origin: {
		sessionId: "source",
		entryId: "entry",
		requestId: "request",
		instanceId: "instance",
		epoch: 0,
		branchAnchor: null,
	},
	copiedFrom: { sessionId: "source", entryId: "entry" },
};

describe("external event records", () => {
	it("keys by original recipient and event", () => {
		expect(externalEventKey(canonical())).toBe('["recipient","event"]');
		expect(externalEventKey({ ...canonical(), recipientIdentity: "other" })).not.toBe(externalEventKey(canonical()));
	});

	it("classifies only the reserved custom entry", () => {
		const entry = {
			type: "custom" as const,
			customType: EXTERNAL_RECORD,
			id: "record",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			data: canonical(),
		};
		expect(readExternalEntry(entry)?.kind).toBe("canonical");
		expect(readExternalEntry({ ...entry, customType: "unrelated" })).toBeUndefined();
	});

	it("refuses malformed history rather than projecting its body", () => {
		expect(() => decodeExternalHistory({ version: 2, envelope: "bad" })).toThrow();
		expect(() => decodeExternalHistory({ version: 1, kind: "inherited" })).toThrow();
	});

	it("validates and deeply freezes inherited history", () => {
		const decoded = decodeExternalHistory(valid);
		expect(Object.isFrozen(decoded)).toBe(true);
		expect(Object.isFrozen(decoded.origin)).toBe(true);
		expect(Object.isFrozen(decoded.provenance)).toBe(true);
		expect(() => decodeExternalHistory({ ...valid, origin: { ...valid.origin, epoch: -1 } })).toThrow();
		expect(() => decodeExternalHistory({ ...valid, extra: true })).toThrow();
		expect(() => decodeExternalHistory({ ...valid, copiedFrom: [] })).toThrow();
		expect(() => decodeExternalHistory({ ...valid, origin: { ...valid.origin, requestId: "" } })).toThrow();
		expect(() => decodeExternalHistory({ ...valid, origin: { ...valid.origin, unexpected: true } })).toThrow();
		expect(() => decodeExternalHistory({ ...valid, copiedFrom: { ...valid.copiedFrom, entryId: "" } })).toThrow();
	});

	it("reserves infrastructure types in every ordinary storage path", () => {
		const f = savedFixture();
		try {
			for (const type of [EXTERNAL_RECORD, EXTERNAL_HISTORY, ACTIVE_SELECTION, ADMISSION_MESSAGE]) {
				expect(() => f.manager.appendCustomEntry(type, valid)).toThrow(/reserved/i);
				expect(() => f.manager.appendCustomMessageEntry(type, "body", false)).toThrow(/reserved/i);
				expect(() =>
					f.manager.appendMessage({
						role: "custom",
						customType: type,
						content: "body",
						display: false,
						timestamp: 0,
					}),
				).toThrow(/reserved/i);
			}
		} finally {
			f.cleanup();
		}
	});

	it("loads and freezes valid history while selecting its ancestry", () => {
		const f = savedFixture();
		try {
			const path = f.manager.getSessionFile()!;
			appendFileSync(
				path,
				`${JSON.stringify({ type: "custom", customType: EXTERNAL_HISTORY, id: "history", parentId: f.selected, timestamp: new Date(0).toISOString(), data: valid })}\n`,
			);
			const reopened = SessionManager.open(path);
			const entry = reopened.getEntry("history");
			expect(entry?.type).toBe("custom");
			expect(reopened.getLeafId()).toBe("history");
			expect(Object.isFrozen(entry)).toBe(true);
			if (entry?.type !== "custom") throw new Error("Expected history entry");
			expect(Object.isFrozen(entry.data)).toBe(true);
			const message = externalEntryToMessage(entry);
			expect(message?.customType).toBe(ADMISSION_MESSAGE);
			expect(message?.content).toBe(valid.envelope);
			expect(message?.display).toBe(false);
			expect(JSON.stringify(reopened.buildSessionContext().messages)).toContain(valid.envelope);
		} finally {
			f.cleanup();
		}
	});

	it("does not overlay an off-branch admission onto a sibling sharing its anchor", () => {
		const f = savedFixture();
		try {
			const event = canonical();
			f.manager.appendEntryOnce(event, f.root);
			const record = admission(event, f.root);
			const id = selectSyntheticAdmission(f.manager, record);
			const admittedLeaf = f.manager.appendMessage(assistantMsg("admitted branch"));
			expect(JSON.stringify(f.manager.buildSessionContext().messages)).toContain(ADMITTED_BODY);
			f.manager.branch(f.selected);
			expect(JSON.stringify(f.manager.buildSessionContext().messages)).not.toContain(ADMITTED_BODY);
			expect(JSON.stringify(f.manager.buildSessionContext().messages)).not.toContain(PENDING_BODY);
			f.manager.branch(admittedLeaf);
			expect(f.manager.getBranch().some((entry) => entry.id === id)).toBe(true);
			expect(JSON.stringify(f.manager.buildSessionContext().messages)).toContain(ADMITTED_BODY);
			const message = externalEntryToMessage(f.manager.getEntry(id)!);
			expect(message?.display).toBe(false);
			expect(message?.content).toBe(record.envelope);
			expect(f.manager.getEntry(id)?.type).toBe("custom");
			expect(f.manager.getEntries().filter((entry) => entry.type === "custom_message")).toEqual([]);
		} finally {
			f.cleanup();
		}
	});

	it("excludes a canonical explicitly selected on the active path", () => {
		const f = savedFixture();
		try {
			const receipt = f.manager.appendEntryOnce(canonical(), f.selected);
			f.manager.branch(receipt.entryId);
			f.manager.appendMessage(userMsg("following user"));
			f.manager.appendMessage(assistantMsg("following assistant"));
			expect(f.manager.getBranch().some((entry) => entry.id === receipt.entryId)).toBe(true);
			expect(JSON.stringify(f.manager.buildSessionContext().messages)).not.toContain(PENDING_BODY);
		} finally {
			f.cleanup();
		}
	});

	it("refuses malformed completed history without repairing the file", () => {
		const f = savedFixture();
		try {
			const path = f.manager.getSessionFile()!;
			appendFileSync(
				path,
				`${JSON.stringify({ type: "custom", customType: EXTERNAL_HISTORY, id: "bad", parentId: f.selected, timestamp: new Date(0).toISOString(), data: { ...valid, origin: [] } })}\n{"partial":`,
			);
			const bytes = readFileSync(path);
			expect(() => SessionManager.open(path)).toThrow();
			expect(readFileSync(path)).toEqual(bytes);
		} finally {
			f.cleanup();
		}
	});
});
