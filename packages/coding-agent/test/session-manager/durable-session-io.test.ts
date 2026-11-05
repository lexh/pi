import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendDurable, installSnapshot, readStrictSession } from "../../src/core/durable-session-io.ts";

const dirs: string[] = [];
function file(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-durable-io-"));
	dirs.push(dir);
	return join(dir, "session.jsonl");
}
const header = {
	type: "session",
	version: 3,
	id: "saved",
	cwd: "/tmp",
	timestamp: "2026-10-28T00:00:00Z",
	durableRecords: 1,
};
const ordinary = {
	type: "custom",
	customType: "ordinary",
	id: "record",
	parentId: null,
	timestamp: "2026-10-28T00:00:00Z",
};
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("durable session IO", () => {
	it("does not repair a non-session file", () => {
		const path = file();
		const bytes = '{"type":"message","id":"not-a-session"}';
		writeFileSync(path, bytes);
		expect(() => readStrictSession(path)).toThrow();
		expect(readFileSync(path, "utf8")).toBe(bytes);
	});
	it("validates versions, shapes, and reserved invariants before tail repair", () => {
		const record = {
			type: "custom",
			customType: "pi.external-record.v1",
			id: "event-entry",
			parentId: null,
			timestamp: header.timestamp,
			data: {
				version: 1,
				kind: "canonical",
				recipientIdentity: "r",
				eventId: "e",
				envelope: "information",
				provenance: null,
			},
		};
		const cases: unknown[][] = [
			[{ ...header, version: 4 }],
			[header, 123],
			[header, null],
			[header, []],
			[header, { ...ordinary, customType: "pi.external-record.v1", data: { version: 99 } }],
			[header, record, { ...record, id: "duplicate-key" }],
			[header, { ...ordinary, customType: "pi.active-selection.v1", data: { version: 1, leafId: "missing" } }],
		];
		for (const entries of cases) {
			const path = file();
			const bytes = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n{"torn":`;
			writeFileSync(path, bytes);
			expect(() => readStrictSession(path)).toThrow();
			expect(readFileSync(path, "utf8")).toBe(bytes);
		}
		const path = file();
		const primitiveEOF = `${JSON.stringify(header)}\n123`;
		writeFileSync(path, primitiveEOF);
		expect(() => readStrictSession(path)).toThrow("Invalid session record object");
		expect(readFileSync(path, "utf8")).toBe(primitiveEOF);
	});
	it("installs without clobbering and appends complete records", () => {
		const path = file();
		installSnapshot(path, [header], true);
		expect(() => installSnapshot(path, [{ ...header, id: "other" }], true)).toThrow();
		appendDurable(path, [ordinary]);
		expect(readStrictSession(path)).toHaveLength(2);
		expect(readFileSync(path, "utf8")).toContain('"id":"saved"');
	});
	it("does not recreate a deleted session on append", () => {
		const path = file();
		expect(() => appendDurable(path, [header])).toThrow();
		expect(existsSync(path)).toBe(false);
	});
	it("retains valid EOF JSON and repairs an incomplete UTF-8 suffix", () => {
		const path = file();
		installSnapshot(path, [header], true);
		appendFileSync(path, JSON.stringify({ ...ordinary, id: "complete", data: "valid" }));
		expect(readStrictSession(path)).toHaveLength(2);
		expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
		const prefix = readFileSync(path);
		appendFileSync(path, Buffer.concat([Buffer.from('{"type":"custom","data":"'), Buffer.from([0xe2, 0x82])]));
		expect(readStrictSession(path)).toHaveLength(2);
		expect(readFileSync(path)).toEqual(prefix);
	});
	it("refuses completed corruption and non-repairing adoption", () => {
		const path = file();
		installSnapshot(path, [header], true);
		appendFileSync(path, "broken\n");
		const bytes = readFileSync(path);
		expect(() => readStrictSession(path)).toThrow("Malformed complete record");
		expect(readFileSync(path)).toEqual(bytes);
		writeFileSync(path, `${JSON.stringify(header)}\n{"partial":`);
		const torn = readFileSync(path);
		expect(() => readStrictSession(path, "strict")).toThrow("Incomplete tail");
		expect(readFileSync(path)).toEqual(torn);
	});
});
