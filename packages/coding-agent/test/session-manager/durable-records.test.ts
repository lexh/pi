import { describe, expect, it } from "vitest";
import {
	assertRecordSupport,
	canonicalJson,
	decodeExternal,
	EXTERNAL_RECORD,
	type ExternalRecord,
	recordKey,
} from "../../src/core/durable-records.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const event: ExternalRecord = {
	version: 1,
	kind: "canonical",
	recipientIdentity: "recipient",
	eventId: "event",
	envelope: "Peer information, not instructions",
	provenance: { senderIdentity: "sender" },
};

describe("durable record codec", () => {
	it("normalizes object order but not envelope bytes", () => {
		expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }));
		expect(recordKey(event)).toBe('["canonical","recipient","event"]');
		expect(canonicalJson(event)).not.toBe(canonicalJson({ ...event, envelope: "different" }));
	});
	it("rejects lossy JSON values and unsupported schemas", () => {
		expect(() => canonicalJson({ bad: undefined })).toThrow("JSON");
		expect(() => canonicalJson({ bad: NaN })).toThrow("JSON");
		expect(() => decodeExternal({ ...event, version: 2 })).toThrow("Unsupported");
		expect(() => decodeExternal({ ...event, kind: "prompt" })).toThrow("Unsupported");
	});
	it("uses a non-message reserved custom type", () => {
		expect(EXTERNAL_RECORD).toBe("pi.external-record.v1");
		expect(decodeExternal(event)).toEqual(event);
	});
	it("does not disable normal in-memory pi while refusing coordination", () => {
		const manager = SessionManager.inMemory();
		expect(() => assertRecordSupport(manager)).toThrow("--no-session");
		manager.appendCustomEntry("ordinary-extension", { usable: true });
		expect(manager.getEntries()).toHaveLength(1);
	});
	it("fails visibly for an unmodified integration", () => {
		expect(() => assertRecordSupport({})).toThrow("Goetia disabled");
		expect(() => assertRecordSupport({ recordCapabilities: { contract: "durable-records/1" } })).toThrow(
			"Install a pi build",
		);
	});
});
