import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSessionContext, parseSessionEntries, SessionManager } from "../../src/core/session-manager.ts";
import { userMsg } from "../utilities.ts";

const dirs: string[] = [];
function make(): SessionManager {
	const dir = mkdtempSync(join(tmpdir(), "pi-persist-now-"));
	dirs.push(dir);
	return SessionManager.create(dir, dir);
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("persistNow", () => {
	it("saves empty state without a prompt and enables later custom appends", () => {
		const manager = make();
		const identity = manager.getSessionId();
		expect(existsSync(manager.getSessionFile()!)).toBe(false);
		const path = manager.persistNow();
		manager.appendCustomEntry("later-state", { count: 1 });
		const reopened = SessionManager.open(path);
		expect(reopened.getSessionId()).toBe(identity);
		expect(reopened.getHeader()?.durableRecords).toBe(1);
		expect(reopened.buildSessionContext().messages).toEqual([]);
		expect(reopened.getEntries().some((entry) => entry.type === "custom" && entry.customType === "later-state")).toBe(
			true,
		);
		const bytes = readFileSync(path, "utf8");
		expect(manager.persistNow()).toBe(path);
		expect(readFileSync(path, "utf8")).toBe(bytes);
	});
	it("refuses unsupported durable record versions without rewriting", () => {
		const manager = make();
		manager.persistNow();
		const path = manager.getSessionFile()!;
		const original = readFileSync(path, "utf8");
		const future = original.replace('"durableRecords":1', '"durableRecords":2');
		writeFileSync(path, future);
		expect(() => SessionManager.open(path)).toThrow("Unsupported durable record version");
		expect(readFileSync(path, "utf8")).toBe(future);
	});
	it("keeps persisted admissions inert while projecting selected model history", () => {
		const data = {
			version: 1,
			kind: "admission",
			recipientIdentity: "original",
			eventId: "event",
			envelope: "Do not copy me to the editor",
			provenance: null,
			requestId: "request",
			instanceId: "instance",
			epoch: 0,
			branchAnchor: null,
		};
		const entries = parseSessionEntries(
			[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "legacy-reader",
					cwd: "/tmp",
					timestamp: "2026-10-28T00:00:00Z",
				}),
				JSON.stringify({
					type: "custom",
					customType: "pi.external-record.v1",
					id: "inert",
					parentId: null,
					timestamp: "2026-10-28T00:00:00Z",
					data,
				}),
			].join("\n"),
		);
		const sessionEntries = entries.filter((entry) => entry.type !== "session");
		expect(sessionEntries).toMatchObject([{ type: "custom", customType: "pi.external-record.v1", data }]);
		expect(buildSessionContext(sessionEntries).messages).toMatchObject([
			{ role: "custom", customType: "pi.external-admission-projection.v1", content: data.envelope, display: false },
		]);
	});
	it("preserves legacy identity and content during explicit adoption", () => {
		const manager = make();
		const original = userMsg("existing work");
		manager.appendMessage(original);
		const path = manager.getSessionFile()!;
		const id = manager.getSessionId();
		expect(SessionManager.open(path).getHeader()?.durableRecords).toBeUndefined();
		manager.persistNow();
		const reopened = SessionManager.open(path);
		expect(reopened.getSessionId()).toBe(id);
		expect(reopened.buildSessionContext().messages).toEqual([original]);
	});
	it("refuses ephemeral sessions and unsafe legacy adoption", () => {
		expect(() => SessionManager.inMemory().persistNow()).toThrow("--no-session");
		const manager = make();
		manager.appendMessage(userMsg("keep"));
		const path = manager.getSessionFile()!;
		const bytes = readFileSync(path, "utf8").replace("\n", "\nbroken\n");
		writeFileSync(path, bytes);
		const legacy = SessionManager.open(path);
		expect(() => legacy.persistNow()).toThrow("Malformed complete record");
		expect(readFileSync(path, "utf8")).toBe(bytes);
	});
	it("remembers an unsafe source even if normal legacy migration rewrites it", () => {
		const manager = make();
		const path = manager.getSessionFile()!;
		writeFileSync(
			path,
			[
				JSON.stringify({
					type: "session",
					version: 2,
					id: "legacy-v2",
					cwd: manager.getCwd(),
					timestamp: "2026-10-28T00:00:00Z",
				}),
				"broken",
				JSON.stringify({
					type: "message",
					id: "u",
					parentId: null,
					timestamp: "2026-10-28T00:00:00Z",
					message: userMsg("legacy work"),
				}),
				"",
			].join("\n"),
		);
		const legacy = SessionManager.open(path);
		expect(legacy.getHeader()?.version).toBe(3);
		expect(legacy.buildSessionContext().messages).toHaveLength(1);
		expect(() => legacy.persistNow()).toThrow("Unsafe legacy adoption");
	});
});
