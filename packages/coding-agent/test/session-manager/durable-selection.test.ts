import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACTIVE_SELECTION, EXTERNAL_RECORD } from "../../src/core/durable-records.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { userMsg } from "../utilities.ts";

const dirs: string[] = [];
function make(): SessionManager {
	const dir = mkdtempSync(join(tmpdir(), "pi-selection-"));
	dirs.push(dir);
	const manager = SessionManager.create(dir, dir);
	manager.persistNow();
	return manager;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("independent durable selection", () => {
	it("persists navigation and null selection without another message", () => {
		const manager = make();
		const root = manager.appendMessage(userMsg("root"));
		manager.appendMessage(userMsg("other branch"));
		manager.branch(root);
		const file = manager.getSessionFile()!;
		expect(SessionManager.open(file).getLeafId()).toBe(root);
		manager.resetLeaf();
		expect(SessionManager.open(file).getLeafId()).toBeNull();
		expect(
			manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === ACTIVE_SELECTION),
		).toBe(false);
		expect(manager.getEntryCount()).toBe(2);
	});
	it("reopens summary navigation and a subsequent ordinary append", () => {
		const manager = make();
		const root = manager.appendMessage(userMsg("root"));
		manager.appendMessage(userMsg("abandoned"));
		const summary = manager.branchWithSummary(root, "summary");
		const reopened = SessionManager.open(manager.getSessionFile()!);
		expect(reopened.getLeafId()).toBe(summary);
		const next = reopened.appendMessage(userMsg("continued"));
		const again = SessionManager.open(manager.getSessionFile()!);
		expect(again.getLeafId()).toBe(next);
		expect(again.getEntry(next)?.parentId).toBe(summary);
	});
	it("ignores an off-branch external physical tail when replaying", () => {
		const manager = make();
		const root = manager.appendMessage(userMsg("root"));
		const selected = manager.appendMessage(userMsg("selected"));
		manager.branch(root);
		const anchor = manager.appendMessage(userMsg("abandoned branch anchor"));
		manager.branch(selected);
		appendFileSync(
			manager.getSessionFile()!,
			`${JSON.stringify({
				type: "custom",
				customType: EXTERNAL_RECORD,
				id: "offbranch",
				parentId: anchor,
				timestamp: "2026-10-28T00:00:00Z",
				data: {
					version: 1,
					kind: "admission",
					recipientIdentity: "recipient",
					eventId: "event",
					envelope: "Not an editable prompt",
					provenance: null,
					requestId: "request",
					instanceId: "instance",
					epoch: 0,
					branchAnchor: anchor,
				},
			})}\n`,
		);
		expect(SessionManager.open(manager.getSessionFile()!).getLeafId()).toBe(selected);
	});
	it("refuses a dangling selection instead of choosing the physical tail", () => {
		const manager = make();
		const file = manager.getSessionFile()!;
		appendFileSync(
			file,
			`${JSON.stringify({
				type: "custom",
				customType: ACTIVE_SELECTION,
				id: "selection-bad",
				parentId: null,
				timestamp: "2026-10-28T00:00:00Z",
				data: { version: 1, leafId: "missing" },
			})}\n`,
		);
		const bytes = readFileSync(file);
		expect(() => SessionManager.open(file)).toThrow("Selection target not found");
		expect(readFileSync(file)).toEqual(bytes);
	});
});
