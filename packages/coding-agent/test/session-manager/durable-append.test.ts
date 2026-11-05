import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertRecordSupport, type ExternalRecord, recordKey } from "../../src/core/durable-records.ts";
import * as io from "../../src/core/durable-session-io.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { userMsg } from "../utilities.ts";

const dirs: string[] = [];
const canonical: ExternalRecord = {
	version: 1,
	kind: "canonical",
	recipientIdentity: "recipient",
	eventId: "event",
	envelope: "Peer information",
	provenance: { senderIdentity: "sender" },
};
function make(): SessionManager {
	const dir = mkdtempSync(join(tmpdir(), "pi-append-once-"));
	dirs.push(dir);
	const manager = SessionManager.create(dir, dir);
	manager.persistNow();
	return manager;
}
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("appendEntryOnce", () => {
	it("returns one stable receipt across off-branch lookup and reopen", () => {
		const manager = make();
		assertRecordSupport(manager);
		const anchor = manager.appendMessage(userMsg("anchor"));
		const selected = manager.appendMessage(userMsg("selected"));
		const first = manager.appendEntryOnce(canonical, anchor);
		const bytes = readFileSync(first.sessionFile);
		expect(manager.getLeafId()).toBe(selected);
		expect(manager.appendEntryOnce(canonical, anchor)).toEqual(first);
		expect(readFileSync(first.sessionFile)).toEqual(bytes);
		const reopened = SessionManager.open(first.sessionFile);
		expect(reopened.getEntryOnce(recordKey(canonical))).toEqual(first);
		expect(reopened.appendEntryOnce(canonical, anchor)).toEqual(first);
		expect(reopened.getLeafId()).toBe(selected);
		expect(reopened.getEntry(first.entryId)?.parentId).toBe(anchor);
		const stored = reopened.getEntry(first.entryId);
		expect(Object.isFrozen(stored)).toBe(true);
		expect(stored?.type === "custom" && Object.isFrozen(stored.data)).toBe(true);
		expect(reopened.buildSessionContext().messages.map((message) => message.role)).toEqual(["user", "user"]);
	});
	it("rejects changed immutable bytes and placement under a key", () => {
		const manager = make();
		const anchor = manager.appendMessage(userMsg("anchor"));
		manager.appendEntryOnce(canonical, anchor);
		expect(() => manager.appendEntryOnce({ ...canonical, envelope: "changed" }, anchor)).toThrow(
			"Record key conflict",
		);
		expect(() => manager.appendEntryOnce(canonical, null)).toThrow("Record key conflict");
		expect(manager.getEntryOnce("missing")).toBeUndefined();
	});
	it("stores distinct admission keys and rejects missing anchors", () => {
		const manager = make();
		const anchor = manager.appendMessage(userMsg("anchor"));
		const record: ExternalRecord = {
			...canonical,
			kind: "admission",
			requestId: "r1",
			instanceId: "i1",
			epoch: 1,
			branchAnchor: anchor,
		};
		const receipt = manager.appendEntryOnce(record, anchor);
		expect(manager.appendEntryOnce(record, anchor)).toEqual(receipt);
		expect(manager.appendEntryOnce({ ...record, requestId: "r2" }, anchor).entryId).not.toBe(receipt.entryId);
		expect(() => manager.appendEntryOnce({ ...record, requestId: "r3", branchAnchor: "missing" }, "missing")).toThrow(
			"Entry missing not found",
		);
		expect(() => manager.appendEntryOnce({ ...record, requestId: "r4" }, null)).toThrow("Admission anchor mismatch");
	});
	it("reserves infrastructure types and does not expose a failed ordinary append", () => {
		const manager = make();
		expect(() => manager.appendCustomEntry("pi.external-record.v1", canonical)).toThrow(
			"Reserved durable record type",
		);
		expect(() => manager.appendCustomEntry("pi.active-selection.v1", { version: 1, leafId: null })).toThrow(
			"Reserved durable record type",
		);
		const before = manager.getEntries();
		const selected = manager.getLeafId();
		vi.spyOn(io, "appendDurable").mockImplementationOnce(() => {
			throw new Error("Injected disk failure");
		});
		expect(() => manager.appendMessage(userMsg("must not enter memory"))).toThrow("Injected disk failure");
		expect(manager.getEntries()).toEqual(before);
		expect(manager.getLeafId()).toBe(selected);
		expect(() => manager.appendEntryOnce(canonical, null)).toThrow("reopen");
	});
	it("repairs a torn admission tail before retrying without losing selection", () => {
		const manager = make();
		const anchor = manager.appendMessage(userMsg("anchor"));
		const selected = manager.appendMessage(userMsg("selected"));
		const file = manager.getSessionFile()!;
		appendFileSync(file, '{"type":"custom","customType":"pi.external-record.v1","data":');
		const reopened = SessionManager.open(file);
		const record: ExternalRecord = {
			...canonical,
			kind: "admission",
			requestId: "torn",
			instanceId: "instance",
			epoch: 0,
			branchAnchor: anchor,
		};
		const receipt = reopened.appendEntryOnce(record, anchor);
		const again = SessionManager.open(file);
		expect(again.appendEntryOnce(record, anchor)).toEqual(receipt);
		expect(again.getLeafId()).toBe(selected);
		expect(again.getEntries().filter((entry) => entry.id === receipt.entryId)).toHaveLength(1);
	});
	it("poisons uncertain writes and reconciles a persisted record after reopen", () => {
		const manager = make();
		const append = io.appendDurable;
		vi.spyOn(io, "appendDurable").mockImplementationOnce((path, entries) => {
			append(path, entries);
			throw new Error("Injected failure after write/sync, before receipt");
		});
		expect(() => manager.appendEntryOnce(canonical, null)).toThrow("Injected failure");
		expect(() => manager.appendEntryOnce(canonical, null)).toThrow("reopen");
		expect(() => manager.getEntryOnce(recordKey(canonical))).toThrow("reopen");
		const reopened = SessionManager.open(manager.getSessionFile()!);
		const receipt = reopened.appendEntryOnce(canonical, null);
		expect(reopened.getEntryOnce(recordKey(canonical))).toEqual(receipt);
		expect(reopened.getEntries()).toHaveLength(1);
	});
});
