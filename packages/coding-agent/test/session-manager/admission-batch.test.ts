import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { ACTIVE_SELECTION, recordKey } from "../../src/core/durable-records.ts";
import * as io from "../../src/core/durable-session-io.ts";
import type { AdmissionEntry } from "../../src/core/request-admission-types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { canonical, savedFixture } from "../helpers/external-events.ts";

function entries(anchor: string): AdmissionEntry[] {
	const first: AdmissionEntry = {
		entryId: "first",
		timestamp: "2026-10-30T12:00:00.000Z",
		record: {
			...canonical("one"),
			kind: "admission",
			requestId: "request",
			instanceId: "instance",
			epoch: 0,
			branchAnchor: anchor,
		},
	};
	return [
		first,
		{
			entryId: "second",
			timestamp: first.timestamp,
			record: { ...first.record, eventId: "two", branchAnchor: first.entryId },
		},
	];
}

describe("admission batches", () => {
	it("repairs and retries a descriptor prefix interleaved with a selected sibling", () => {
		const f = savedFixture();
		try {
			const batch = entries(f.selected);
			const first = f.manager.appendAdmissionBatchOnce(batch.slice(0, 1));
			const sibling = f.manager.appendMessage({ role: "user", content: "sibling", timestamp: 1 });
			expect(f.manager.getLeafId()).toBe(sibling);
			const file = f.manager.getSessionFile()!;
			const reopened = SessionManager.open(file);
			expect(reopened.getLeafId()).toBe(sibling);
			const receipts = reopened.appendAdmissionBatchOnce(batch);
			expect(receipts).toEqual(
				batch.map((entry) => ({
					sessionId: f.manager.getSessionId(),
					sessionFile: file,
					entryId: entry.entryId,
					key: recordKey(entry.record),
				})),
			);
			expect(receipts[0]).toEqual(first[0]);
			expect(reopened.getEntry("first")?.parentId).toBe(f.selected);
			expect(reopened.getEntry("second")?.parentId).toBe("first");
			expect(reopened.getLeafId()).toBe(sibling);
			const bytes = readFileSync(file);
			const again = SessionManager.open(file);
			expect(again.getLeafId()).toBe(sibling);
			const append = vi.spyOn(io, "appendDurable");
			expect(again.appendAdmissionBatchOnce(batch)).toEqual(receipts);
			expect(readFileSync(file)).toEqual(bytes);
			expect(again.getLeafId()).toBe(sibling);
			const third = SessionManager.open(file);
			expect(third.getLeafId()).toBe(sibling);
			expect(third.appendAdmissionBatchOnce(batch)).toEqual(receipts);
			expect(readFileSync(file)).toEqual(bytes);
			expect(third.getLeafId()).toBe(sibling);
			expect(append).not.toHaveBeenCalled();
		} finally {
			vi.restoreAllMocks();
			f.cleanup();
		}
	});
	it("appends only a missing suffix and never writes a complete or empty retry", () => {
		const f = savedFixture();
		try {
			const batch = entries(f.selected);
			const first = f.manager.appendAdmissionBatchOnce(batch.slice(0, 1));
			const reopened = SessionManager.open(f.manager.getSessionFile()!);
			const append = vi.spyOn(io, "appendDurable");
			const receipts = reopened.appendAdmissionBatchOnce(batch);
			expect(receipts[0]).toEqual(first[0]);
			expect(append).toHaveBeenCalledTimes(1);
			expect(append.mock.calls[0]![1]).toEqual([reopened.getEntry("second")]);
			const bytes = readFileSync(f.manager.getSessionFile()!);
			append.mockClear();
			expect(reopened.appendAdmissionBatchOnce(batch)).toEqual(receipts);
			expect(reopened.appendAdmissionBatchOnce([])).toEqual([]);
			expect(append).not.toHaveBeenCalled();
			expect(readFileSync(f.manager.getSessionFile()!)).toEqual(bytes);
			expect(SessionManager.open(f.manager.getSessionFile()!).getLeafId()).toBe(f.selected);
		} finally {
			vi.restoreAllMocks();
			f.cleanup();
		}
	});
	it("rejects conflicts and malformed chains before writing", () => {
		const f = savedFixture();
		try {
			const batch = entries(f.selected);
			const file = f.manager.getSessionFile()!;
			const selection = readFileSync(file, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
				.find((entry) => entry.customType === ACTIVE_SELECTION);
			const invalid: AdmissionEntry[][] = [
				[{ ...batch[0]!, entryId: selection.id }],
				[{ ...batch[0]!, timestamp: "invalid" }],
				[{ ...batch[0]!, record: { ...batch[0]!.record, branchAnchor: "missing" } }],
				[batch[0]!, { ...batch[1]!, entryId: batch[0]!.entryId }],
				[batch[0]!, { ...batch[1]!, record: { ...batch[1]!.record, eventId: "one" } }],
				...["requestId", "recipientIdentity", "instanceId", "epoch"].map((field) => [
					batch[0]!,
					{ ...batch[1]!, record: { ...batch[1]!.record, [field]: field === "epoch" ? 1 : "other" } },
				]),
				[batch[0]!, { ...batch[1]!, record: { ...batch[1]!.record, branchAnchor: f.selected } }],
			];
			const before = readFileSync(file);
			for (const descriptors of invalid) {
				expect(() => f.manager.appendAdmissionBatchOnce(descriptors)).toThrow();
				expect(readFileSync(file)).toEqual(before);
			}
			f.manager.appendAdmissionBatchOnce(batch);
			const after = readFileSync(file);
			expect(() =>
				f.manager.appendAdmissionBatchOnce([{ ...batch[0]!, timestamp: "2026-10-30T12:00:01.000Z" }]),
			).toThrow();
			expect(() => f.manager.appendAdmissionBatchOnce([{ ...batch[0]!, entryId: "different" }])).toThrow();
			expect(() =>
				f.manager.appendAdmissionBatchOnce([
					{ ...batch[0]!, entryId: "absent", record: { ...batch[0]!.record, eventId: "new" } },
					batch[1]!,
				]),
			).toThrow();
			expect(readFileSync(file)).toEqual(after);
			expect(() => SessionManager.inMemory().appendAdmissionBatchOnce(batch)).toThrow();
			expect(() => SessionManager.create(f.directory, f.directory).appendAdmissionBatchOnce(batch)).toThrow();
		} finally {
			f.cleanup();
		}
	});
	it("rejects an existing descriptor after a missing prefix without writing", () => {
		const f = savedFixture();
		try {
			const batch = entries(f.selected);
			const second = batch[1]!;
			io.appendDurable(f.manager.getSessionFile()!, [
				{
					type: "custom",
					customType: "pi.external-record.v1",
					id: second.entryId,
					parentId: second.record.branchAnchor,
					timestamp: second.timestamp,
					data: second.record,
				},
			]);
			const reopened = SessionManager.open(f.manager.getSessionFile()!);
			const before = readFileSync(f.manager.getSessionFile()!);
			expect(() => reopened.appendAdmissionBatchOnce(batch)).toThrow(/non-prefix/);
			expect(readFileSync(f.manager.getSessionFile()!)).toEqual(before);
		} finally {
			f.cleanup();
		}
	});
	it("poisons uncertain writes and recovers the durable chain after reopening", () => {
		const f = savedFixture();
		try {
			const batch = entries(f.selected);
			const append = io.appendDurable;
			vi.spyOn(io, "appendDurable").mockImplementationOnce((path, records) => {
				append(path, records);
				throw new Error("lost receipt");
			});
			expect(() => f.manager.appendAdmissionBatchOnce(batch)).toThrow("lost receipt");
			expect(() => f.manager.appendAdmissionBatchOnce(batch)).toThrow("reopen");
			const reopened = SessionManager.open(f.manager.getSessionFile()!);
			expect(reopened.appendAdmissionBatchOnce(batch).map((receipt) => receipt.entryId)).toEqual([
				"first",
				"second",
			]);
			expect(reopened.getLeafId()).toBe(f.selected);
		} finally {
			vi.restoreAllMocks();
			f.cleanup();
		}
	});
	it("materializes a two-entry chain without selecting it, including on retry after reopen", () => {
		const f = savedFixture();
		try {
			const first: AdmissionEntry = {
				entryId: "reserved-first",
				timestamp: "2026-10-30T12:00:00.000Z",
				record: {
					...canonical("one"),
					kind: "admission",
					requestId: "request-one",
					instanceId: "instance",
					epoch: 0,
					branchAnchor: f.selected,
				},
			};
			const second: AdmissionEntry = {
				entryId: "reserved-second",
				timestamp: first.timestamp,
				record: { ...first.record, eventId: "two", branchAnchor: first.entryId },
			};
			const receipts = f.manager.appendAdmissionBatchOnce([first, second]);
			expect(receipts.map((receipt) => receipt.entryId)).toEqual([first.entryId, second.entryId]);
			expect(f.manager.getLeafId()).toBe(f.selected);
			const reopened = SessionManager.open(f.manager.getSessionFile()!);
			expect(reopened.getLeafId()).toBe(f.selected);
			expect(reopened.appendAdmissionBatchOnce([first, second])).toEqual(receipts);
			expect(reopened.getEntry(second.entryId)?.parentId).toBe(first.entryId);
		} finally {
			f.cleanup();
		}
	});
});
