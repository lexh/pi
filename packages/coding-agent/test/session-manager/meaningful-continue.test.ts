import { appendFileSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findMostRecentSession, SessionManager } from "../../src/core/session-manager.ts";
import { userMsg } from "../utilities.ts";

const dirs: string[] = [];
function dir(): string {
	const value = mkdtempSync(join(tmpdir(), "pi-continue-"));
	dirs.push(value);
	return value;
}
function touch(manager: SessionManager, seconds: number): void {
	utimesSync(manager.getSessionFile()!, seconds, seconds);
}
afterEach(() => {
	for (const value of dirs.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("meaningful continue", () => {
	it("prefers conversation over a newer registration-only session", () => {
		const directory = dir();
		const work = SessionManager.create(directory, directory);
		work.appendMessage(userMsg("work"));
		touch(work, 100);
		const unused = SessionManager.create(directory, directory);
		unused.persistNow();
		touch(unused, 200);
		expect(SessionManager.continueRecent(directory, directory).getSessionFile()).toBe(work.getSessionFile());
	});
	it("treats canonical coordination content as meaningful without a prompt", () => {
		const directory = dir();
		const mail = SessionManager.create(directory, directory);
		mail.persistNow();
		mail.appendEntryOnce(
			{ version: 1, kind: "canonical", recipientIdentity: "r", eventId: "e", envelope: "content", provenance: null },
			null,
		);
		touch(mail, 100);
		const unused = SessionManager.create(directory, directory);
		unused.persistNow();
		touch(unused, 200);
		expect(SessionManager.continueRecent(directory, directory).getSessionFile()).toBe(mail.getSessionFile());
	});
	it("continues the newest meaningful crashed session without discovery mutation", () => {
		const directory = dir();
		const older = SessionManager.create(directory, directory);
		older.appendMessage(userMsg("older"));
		touch(older, 100);
		const crashed = SessionManager.create(directory, directory);
		crashed.persistNow();
		crashed.appendMessage(userMsg("recover me"));
		const file = crashed.getSessionFile()!;
		const prefix = readFileSync(file);
		appendFileSync(file, '{"type":"custom","data":');
		touch(crashed, 200);
		const torn = readFileSync(file);
		expect(findMostRecentSession(directory, directory)).toBe(file);
		expect(readFileSync(file)).toEqual(torn);
		expect(SessionManager.continueRecent(directory, directory).getSessionFile()).toBe(file);
		expect(readFileSync(file)).toEqual(prefix);
	});
	it("falls back to the newest empty saved session and respects cwd filtering", () => {
		const directory = dir();
		const first = SessionManager.create(directory, directory);
		first.persistNow();
		touch(first, 100);
		const second = SessionManager.create(directory, directory);
		second.persistNow();
		touch(second, 200);
		const foreign = SessionManager.create(join(directory, "other-project"), directory);
		foreign.appendMessage(userMsg("foreign"));
		touch(foreign, 300);
		expect(SessionManager.continueRecent(directory, directory).getSessionFile()).toBe(second.getSessionFile());
	});
});
