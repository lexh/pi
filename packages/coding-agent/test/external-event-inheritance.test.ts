import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as durableIO from "../src/core/durable-session-io.ts";
import { copyExternalHistory } from "../src/core/external-event-inheritance.ts";
import { readExternalEntry } from "../src/core/external-event-records.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	ADMITTED_BODY,
	admission,
	canonical,
	PENDING_BODY,
	savedFixture,
	selectSyntheticAdmission,
} from "./helpers/external-events.ts";
import { userMsg } from "./utilities.ts";

describe("external event inheritance", () => {
	it("repairs parents, label closure, compaction boundaries and branch-summary origins on the original path", () => {
		const time = new Date(0).toISOString();
		const entries: SessionEntry[] = [
			{ type: "message", id: "root", parentId: null, timestamp: time, message: userMsg("root") },
			{
				type: "custom",
				id: "pending",
				parentId: "root",
				timestamp: time,
				customType: "pi.external-record.v1",
				data: canonical(),
			},
			{ type: "label", id: "label1", parentId: "pending", timestamp: time, targetId: "pending", label: "drop" },
			{ type: "label", id: "label2", parentId: "label1", timestamp: time, targetId: "label1", label: "drop too" },
			{ type: "message", id: "kept", parentId: "label2", timestamp: time, message: userMsg("kept") },
			{ type: "message", id: "sibling", parentId: "pending", timestamp: time, message: userMsg("sibling") },
			{
				type: "compaction",
				id: "comp",
				parentId: "kept",
				timestamp: time,
				firstKeptEntryId: "label1",
				summary: "summary",
				tokensBefore: 1,
			},
			{
				type: "branch_summary",
				id: "branch",
				parentId: "comp",
				timestamp: time,
				fromId: "label2",
				summary: "branch",
			},
		];
		const copied = copyExternalHistory(entries, "source");
		expect(copied.map((entry) => entry.id)).toEqual(["root", "kept", "sibling", "comp", "branch"]);
		expect(copied.find((entry) => entry.id === "kept")?.parentId).toBe("root");
		expect(copied.find((entry) => entry.id === "comp")).toMatchObject({ firstKeptEntryId: "kept" });
		expect(copied.find((entry) => entry.id === "branch")).toMatchObject({ fromId: "root" });
	});

	it("saves an empty strict fork from a canonical root and leaves the source untouched on install failure", () => {
		const f = savedFixture();
		try {
			const pending = f.manager.appendEntryOnce(canonical(), null).entryId;
			const source = f.manager.getSessionFile()!;
			const copy = SessionManager.open(source);
			const before = readFileSync(source);
			const identity = {
				id: copy.getSessionId(),
				leaf: copy.getLeafId(),
				file: copy.getSessionFile(),
				entries: copy.getEntries(),
			};
			const failure = vi.spyOn(durableIO, "installSnapshot").mockImplementation(() => {
				throw new Error("injected install failure");
			});
			expect(() => copy.createBranchedSession(pending)).toThrow("injected install failure");
			failure.mockRestore();
			expect(copy.getSessionId()).toBe(identity.id);
			expect(copy.getSessionFile()).toBe(identity.file);
			expect(copy.getLeafId()).toBe(identity.leaf);
			expect(copy.getEntries()).toEqual(identity.entries);
			expect(readFileSync(source)).toEqual(before);
			const path = copy.createBranchedSession(pending)!;
			const reopened = SessionManager.open(path);
			expect(reopened.getHeader()?.durableRecords).toBe(1);
			expect(reopened.getLeafId()).toBeNull();
			expect(reopened.getEntries()).toEqual([]);
		} finally {
			vi.restoreAllMocks();
			f.cleanup();
		}
	});
	it("copies history-only strict sessions and prefers them to unused registrations", () => {
		const f = savedFixture();
		try {
			const admitted = selectSyntheticAdmission(f.manager, admission(canonical("history", "other"), null));
			const path = SessionManager.open(f.manager.getSessionFile()!).createBranchedSession(admitted)!;
			const reopened = SessionManager.open(path);
			expect(reopened.getHeader()?.durableRecords).toBe(1);
			expect(reopened.getEntries()).toHaveLength(1);
			expect(readExternalEntry(reopened.getEntries()[0]!)).toMatchObject({ kind: "inherited" });
			utimesSync(path, 100, 100);
			const unused = SessionManager.create(f.directory, f.directory);
			unused.persistNow();
			utimesSync(unused.getSessionFile()!, 200, 200);
			utimesSync(f.manager.getSessionFile()!, 50, 50);
			expect(SessionManager.continueRecent(f.directory, f.directory).getSessionFile()).toBe(path);
		} finally {
			f.cleanup();
		}
	});

	it("preserves a null selection in a strict whole-tree copy with physical branches", () => {
		const f = savedFixture();
		try {
			const pending = f.manager.appendEntryOnce(canonical("pending"), f.selected).entryId;
			f.manager.branch(pending);
			const ordinary = f.manager.appendMessage(userMsg("ordinary after pending"));
			const admitted = selectSyntheticAdmission(f.manager, admission(canonical("admitted", "other"), ordinary));
			const branch = f.manager.appendMessage(userMsg("ordinary after admission"));
			f.manager.branch(f.root);
			const sibling = f.manager.appendMessage(userMsg("ordinary sibling"));
			f.manager.resetLeaf();
			const source = f.manager.getSessionFile()!;
			const bytes = readFileSync(source);
			expect(SessionManager.open(source).getLeafId()).toBeNull();
			const copy = SessionManager.forkFrom(source, f.directory, f.directory);
			const destination = SessionManager.open(copy.getSessionFile()!);
			expect(destination.getLeafId()).toBeNull();
			expect(destination.getEntry(branch)).toBeDefined();
			expect(destination.getEntry(sibling)).toBeDefined();
			expect(readExternalEntry(destination.getEntry(admitted)!)).toMatchObject({ kind: "inherited" });
			expect(
				destination
					.getEntries()
					.some((entry) => ["canonical", "admission"].includes(readExternalEntry(entry)?.kind ?? "")),
			).toBe(false);
			expect(readFileSync(destination.getSessionFile()!, "utf8")).not.toContain(PENDING_BODY);
			expect(readFileSync(source)).toEqual(bytes);
			expect(f.manager.getLeafId()).toBeNull();
			expect(SessionManager.open(source).getLeafId()).toBeNull();
		} finally {
			f.cleanup();
		}
	});

	it("repairs a selected removed label for a whole-tree copy", () => {
		const f = savedFixture();
		try {
			const pending = f.manager.appendEntryOnce(canonical(), f.selected).entryId;
			f.manager.branch(pending);
			const label = f.manager.appendLabelChange(pending, "removed");
			f.manager.branch(label);
			const destination = SessionManager.forkFrom(f.manager.getSessionFile()!, f.directory, f.directory);
			expect(SessionManager.open(destination.getSessionFile()!).getLeafId()).toBe(f.selected);
		} finally {
			f.cleanup();
		}
	});

	it("does not overwrite a colliding strict destination or mutate the source manager", () => {
		const f = savedFixture();
		try {
			const source = SessionManager.open(f.manager.getSessionFile()!);
			const original = readFileSync(source.getSessionFile()!);
			const collision = join(f.directory, "collision.jsonl");
			writeFileSync(collision, "existing bytes");
			const install = durableIO.installSnapshot;
			const spy = vi
				.spyOn(durableIO, "installSnapshot")
				.mockImplementation((_path, snapshot, noClobber) => install(collision, snapshot, noClobber));
			expect(() => source.createBranchedSession(f.selected)).toThrow();
			spy.mockRestore();
			expect(readFileSync(collision, "utf8")).toBe("existing bytes");
			expect(readFileSync(source.getSessionFile()!)).toEqual(original);
			expect(source.getLeafId()).toBe(f.selected);
		} finally {
			vi.restoreAllMocks();
			f.cleanup();
		}
	});

	it("retains ordinary legacy branches and deferred persistence", () => {
		const f = savedFixture();
		try {
			const legacy = SessionManager.create(f.directory, f.directory);
			const root = legacy.appendMessage(userMsg("legacy root"));
			legacy.appendMessage(userMsg("legacy branch"));
			legacy.branch(root);
			const sibling = legacy.appendMessage(userMsg("legacy sibling"));
			const source = legacy.getSessionFile()!;
			const copy = SessionManager.forkFrom(source, f.directory, f.directory);
			const reopened = SessionManager.open(copy.getSessionFile()!);
			expect(reopened.getHeader()?.durableRecords).toBeUndefined();
			expect(reopened.getEntry(sibling)).toBeDefined();
			expect(reopened.getEntries().filter((entry) => entry.type === "message")).toHaveLength(3);
			const empty = SessionManager.create(f.directory, f.directory);
			const only = empty.appendModelChange("provider", "model");
			const path = empty.createBranchedSession(only)!;
			expect(() => readFileSync(path)).toThrow();
		} finally {
			f.cleanup();
		}
	});

	for (const method of ["path", "whole-tree"] as const) {
		it(`sanitizes saved legacy v3 external records for ${method}`, () => {
			const f = savedFixture();
			try {
				const source = join(f.directory, `legacy-${method}.jsonl`);
				const timestamp = new Date(0).toISOString();
				const origin = {
					sessionId: "original-session",
					entryId: "original-entry",
					requestId: "original-request",
					instanceId: "original-instance",
					epoch: 2,
					branchAnchor: "original-anchor",
				};
				const inherited = {
					...canonical("inherited", ADMITTED_BODY),
					kind: "inherited",
					origin,
					copiedFrom: { sessionId: "earlier-copy", entryId: "earlier-entry" },
				};
				const entries = [
					{ type: "session", version: 3, id: "legacy-source", timestamp, cwd: f.directory },
					{ type: "message", id: "root", parentId: null, timestamp, message: userMsg("legacy root") },
					{
						type: "custom",
						id: "pending",
						parentId: "root",
						timestamp,
						customType: "pi.external-record.v1",
						data: canonical("pending"),
					},
					{ type: "message", id: "anchor", parentId: "pending", timestamp, message: userMsg("legacy anchor") },
					{
						type: "custom",
						id: "admitted",
						parentId: "anchor",
						timestamp,
						customType: "pi.external-record.v1",
						data: admission(canonical("admitted", "other"), "anchor"),
					},
					{
						type: "custom",
						id: "history",
						parentId: "admitted",
						timestamp,
						customType: "pi.external-history.v1",
						data: inherited,
					},
					{ type: "message", id: "leaf", parentId: "history", timestamp, message: userMsg("legacy leaf") },
				];
				writeFileSync(source, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
				const bytes = readFileSync(source);
				const opened = SessionManager.open(source);
				expect(opened.getHeader()?.durableRecords).toBeUndefined();
				expect(opened.getLeafId()).toBe("leaf");
				const path =
					method === "path"
						? opened.createBranchedSession("leaf")!
						: SessionManager.forkFrom(source, f.directory, f.directory).getSessionFile()!;
				const destination = SessionManager.open(path);
				expect(destination.getHeader()?.durableRecords).toBeUndefined();
				expect(readFileSync(source)).toEqual(bytes);
				expect(SessionManager.open(source).getLeafId()).toBe("leaf");
				expect(readFileSync(path, "utf8")).not.toContain(PENDING_BODY);
				expect(
					destination
						.getEntries()
						.some((entry) => ["canonical", "admission"].includes(readExternalEntry(entry)?.kind ?? "")),
				).toBe(false);
				expect(JSON.stringify(destination.buildSessionContext().messages)).toContain(ADMITTED_BODY);
				expect(readExternalEntry(destination.getEntry("admitted")!)).toMatchObject({
					kind: "inherited",
					origin: { sessionId: "legacy-source", entryId: "admitted", requestId: "request" },
					copiedFrom: { sessionId: "legacy-source", entryId: "admitted" },
				});
				expect(readExternalEntry(destination.getEntry("history")!)).toMatchObject({
					kind: "inherited",
					origin,
					copiedFrom: { sessionId: "legacy-source", entryId: "history" },
				});
			} finally {
				f.cleanup();
			}
		});

		it(`removes canonical records and copies admitted history for ${method}`, () => {
			const f = savedFixture();
			try {
				const pending = f.manager.appendEntryOnce(canonical("pending"), f.selected).entryId;
				f.manager.branch(pending);
				const removedLabel = f.manager.appendLabelChange(pending, "removed label");
				const compaction = f.manager.appendCompaction("earlier history", pending, 100);
				const anchor = f.manager.appendMessage(userMsg("after pending"));
				const admitted = selectSyntheticAdmission(
					f.manager,
					admission(canonical("admitted", "OTHER_CANONICAL"), anchor),
				);
				const leaf = f.manager.appendMessage(userMsg("after admission"));
				f.manager.appendLabelChange(admitted, "admitted label");
				f.manager.branch(anchor);
				const sibling = f.manager.appendMessage(userMsg("ordinary sibling"));
				f.manager.branch(leaf);
				const source = f.manager.getSessionFile()!;
				const bytes = readFileSync(source);
				const sourceId = f.manager.getSessionId();
				const copy = method === "path" ? SessionManager.open(source) : undefined;
				const destinationPath =
					method === "path"
						? copy!.createBranchedSession(leaf)!
						: SessionManager.forkFrom(source, f.directory, f.directory).getSessionFile()!;
				const destination = SessionManager.open(destinationPath);
				expect(readFileSync(source)).toEqual(bytes);
				expect(destination.getSessionId()).not.toBe(sourceId);
				expect(f.manager.getLeafId()).toBe(leaf);
				expect(destination.getEntries().some((entry) => entry.id === removedLabel)).toBe(false);
				expect(destination.getEntry(compaction)).toMatchObject({ firstKeptEntryId: compaction });
				expect(destination.getLabel(admitted)).toBe("admitted label");
				expect(destination.getEntries().some((entry) => entry.type === "custom_message")).toBe(false);
				if (method === "whole-tree") {
					expect(destination.getEntry(sibling)).toBeDefined();
					expect(destination.getLeafId()).toBe(leaf);
				}
				expect(readFileSync(destinationPath, "utf8")).not.toContain(PENDING_BODY);
				expect(destination.getEntries().some((entry) => readExternalEntry(entry)?.kind === "canonical")).toBe(
					false,
				);
				expect(destination.getEntries().some((entry) => readExternalEntry(entry)?.kind === "admission")).toBe(
					false,
				);
				expect(JSON.stringify(destination.buildSessionContext().messages)).toContain(ADMITTED_BODY);
				const inherited = destination
					.getEntries()
					.map(readExternalEntry)
					.find((record) => record?.kind === "inherited");
				expect(inherited).toMatchObject({
					kind: "inherited",
					origin: { sessionId: sourceId, requestId: "request" },
					copiedFrom: { sessionId: sourceId, entryId: admitted },
				});
			} finally {
				f.cleanup();
			}
		});
	}
});
