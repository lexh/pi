export const EXTERNAL_RECORD = "pi.external-record.v1";
export const ACTIVE_SELECTION = "pi.active-selection.v1";
export const EXTERNAL_HISTORY = "pi.external-history.v1";
export const ADMISSION_MESSAGE = "pi.external-admission-projection.v1";
export const CANDIDATE_MESSAGE = "pi.external-admission-candidate.v1";
export const RECORD_CAPABILITIES = Object.freeze({
	contract: "durable-records/1",
	encoding: "pi-custom-v1",
	persistEmpty: true,
	keyedAppend: true,
	independentSelection: true,
	incompleteTailRecovery: true,
});

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
interface ExternalBase {
	version: 1;
	recipientIdentity: string;
	eventId: string;
	envelope: string;
	provenance: JsonValue;
}
export type ExternalRecord =
	| (ExternalBase & { kind: "canonical" })
	| (ExternalBase & {
			kind: "admission";
			requestId: string;
			instanceId: string;
			epoch: number;
			branchAnchor: string | null;
	  });
export interface AdmissionOrigin {
	sessionId: string;
	entryId: string;
	requestId: string;
	instanceId: string;
	epoch: number;
	branchAnchor: string | null;
}

export interface ExternalHistory {
	version: 1;
	kind: "inherited";
	recipientIdentity: string;
	eventId: string;
	envelope: string;
	provenance: JsonValue;
	origin: AdmissionOrigin;
	copiedFrom: { sessionId: string; entryId: string };
}

/** Reject a reserved custom type on an ordinary append (custom entry, custom message entry or message). */
export function assertOrdinaryEntry(entry: {
	type: string;
	customType?: string;
	message?: { role: string; customType?: string };
}): void {
	if (entry.type === "custom" || entry.type === "custom_message") assertOrdinaryCustomType(entry.customType ?? "");
	if (entry.type === "message" && entry.message?.role === "custom")
		assertOrdinaryCustomType(entry.message.customType ?? "");
}

const reservedEntryIds = new WeakMap<object, Set<string>>();

/** Physical entry ids kept out of a session's tree index (selection checkpoints); new ids avoid them. */
export function reserveEntryId(index: object, id: string): void {
	let ids = reservedEntryIds.get(index);
	if (!ids) {
		ids = new Set();
		reservedEntryIds.set(index, ids);
	}
	ids.add(id);
}

export function isReservedEntryId(index: object, id: string): boolean {
	return reservedEntryIds.get(index)?.has(id) === true;
}

export function assertOrdinaryCustomType(customType: string): void {
	if (
		[EXTERNAL_RECORD, EXTERNAL_HISTORY, ACTIVE_SELECTION, ADMISSION_MESSAGE, CANDIDATE_MESSAGE].includes(customType)
	) {
		throw new Error("Reserved external infrastructure type (Reserved durable record type)");
	}
}

export interface EntryReceipt {
	sessionId: string;
	sessionFile: string;
	entryId: string;
	key: string;
}
export interface RecordStore {
	readonly recordCapabilities: typeof RECORD_CAPABILITIES;
	isPersisted(): boolean;
	persistNow(): string;
	appendEntryOnce(record: ExternalRecord, parentId: string | null): EntryReceipt;
	getEntryOnce(key: string): EntryReceipt | undefined;
}
export interface SelectionData {
	version: 1;
	leafId: string | null;
}

export function canonicalJson(value: unknown): string {
	const seen = new Set<object>();
	const visit = (input: unknown): JsonValue => {
		if (input === null || typeof input === "string" || typeof input === "boolean") return input;
		if (typeof input === "number" && Number.isFinite(input)) return input;
		if (typeof input !== "object" || input === null) throw new Error("Value is not lossless JSON");
		if (seen.has(input)) throw new Error("Cyclic JSON value");
		seen.add(input);
		try {
			if (Array.isArray(input)) {
				return Array.from(input, (item) => visit(item));
			}
			const prototype = Object.getPrototypeOf(input);
			if (prototype !== Object.prototype && prototype !== null) throw new Error("Value is not plain JSON");
			if (Object.getOwnPropertySymbols(input).length) throw new Error("Symbol keys are not JSON");
			const object = input as Record<string, unknown>;
			return Object.fromEntries(
				Object.keys(object)
					.sort()
					.map((key) => [key, visit(object[key])]),
			);
		} finally {
			seen.delete(input);
		}
	};
	return JSON.stringify(visit(value));
}

export function decodeExternal(value: unknown): ExternalRecord {
	const normalized: unknown = JSON.parse(canonicalJson(value));
	if (typeof normalized !== "object" || normalized === null || Array.isArray(normalized)) {
		throw new Error("Unsupported external record");
	}
	const object = normalized as Record<string, unknown>;
	const text = (key: string) => typeof object[key] === "string" && (object[key] as string).length > 0;
	const base = ["version", "kind", "recipientIdentity", "eventId", "envelope", "provenance"];
	const admission = ["requestId", "instanceId", "epoch", "branchAnchor"];
	const keys = object.kind === "canonical" ? base : [...base, ...admission];
	if (
		object.version !== 1 ||
		!["canonical", "admission"].includes(String(object.kind)) ||
		!text("recipientIdentity") ||
		!text("eventId") ||
		typeof object.envelope !== "string" ||
		!("provenance" in object) ||
		Object.keys(object).some((key) => !keys.includes(key)) ||
		keys.some((key) => !(key in object))
	) {
		throw new Error("Unsupported external record schema");
	}
	if (
		object.kind === "admission" &&
		(!text("requestId") ||
			!text("instanceId") ||
			!Number.isSafeInteger(object.epoch) ||
			(object.epoch as number) < 0 ||
			!(object.branchAnchor === null || text("branchAnchor")))
	) {
		throw new Error("Unsupported admission schema");
	}
	const freeze = (item: unknown): void => {
		if (item === null || typeof item !== "object") return;
		for (const child of Object.values(item)) freeze(child);
		Object.freeze(item);
	};
	freeze(normalized);
	return normalized as ExternalRecord;
}

export function decodeExternalHistory(value: unknown): ExternalHistory {
	const normalized: unknown = JSON.parse(canonicalJson(value));
	if (typeof normalized !== "object" || normalized === null || Array.isArray(normalized)) {
		throw new Error("Unsupported external history schema");
	}
	const object = normalized as Record<string, unknown>;
	const exact = (value: unknown, keys: string[]): value is Record<string, unknown> =>
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		Object.keys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key));
	if (
		!exact(object, [
			"version",
			"kind",
			"recipientIdentity",
			"eventId",
			"envelope",
			"provenance",
			"origin",
			"copiedFrom",
		]) ||
		object.version !== 1 ||
		object.kind !== "inherited" ||
		!exact(object.origin, ["sessionId", "entryId", "requestId", "instanceId", "epoch", "branchAnchor"]) ||
		!exact(object.copiedFrom, ["sessionId", "entryId"])
	) {
		throw new Error("Unsupported external history schema");
	}
	const origin = object.origin;
	const copiedFrom = object.copiedFrom;
	for (const value of [origin.sessionId, origin.entryId, copiedFrom.sessionId, copiedFrom.entryId]) {
		if (typeof value !== "string" || !value) throw new Error("Unsupported external history provenance");
	}
	decodeExternal({
		version: object.version,
		kind: "admission",
		recipientIdentity: object.recipientIdentity,
		eventId: object.eventId,
		envelope: object.envelope,
		provenance: object.provenance,
		requestId: origin.requestId,
		instanceId: origin.instanceId,
		epoch: origin.epoch,
		branchAnchor: origin.branchAnchor,
	});
	const freeze = (item: unknown): void => {
		if (item === null || typeof item !== "object") return;
		for (const child of Object.values(item)) freeze(child);
		Object.freeze(item);
	};
	freeze(normalized);
	return normalized as ExternalHistory;
}

export function decodeSelection(value: unknown): SelectionData {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid selection");
	const object = value as Record<string, unknown>;
	if (
		object.version !== 1 ||
		Object.keys(object).length !== 2 ||
		!(object.leafId === null || (typeof object.leafId === "string" && object.leafId.length > 0))
	) {
		throw new Error("Invalid selection");
	}
	return { version: 1, leafId: object.leafId as string | null };
}

export function validateStoredSession(entries: readonly unknown[]): void {
	const object = (value: unknown): Record<string, unknown> => {
		if (typeof value !== "object" || value === null || Array.isArray(value))
			throw new Error("Invalid session record object");
		const result = value as Record<string, unknown>;
		if (typeof result.type !== "string") throw new Error("Invalid session record type");
		return result;
	};
	if (!entries.length) throw new Error("Invalid session header");
	const header = object(entries[0]);
	if (header.type !== "session" || typeof header.id !== "string" || !header.id)
		throw new Error("Invalid session header");
	const version = header.version ?? 1;
	if (!Number.isSafeInteger(version) || (version as number) < 1 || (version as number) > 3) {
		throw new Error(`Unsupported session version: ${String(version)}`);
	}
	if (header.durableRecords !== undefined && header.durableRecords !== 1) {
		throw new Error(`Unsupported durable record version: ${String(header.durableRecords)}`);
	}
	const ids = new Set<string>();
	const treeIds = new Set<string>();
	const keys = new Set<string>();
	for (const value of entries.slice(1)) {
		const entry = object(value);
		if (entry.type === "session") throw new Error("Duplicate session header");
		if (
			(version as number) >= 2 &&
			(typeof entry.id !== "string" ||
				!entry.id ||
				!(entry.parentId === null || typeof entry.parentId === "string") ||
				typeof entry.timestamp !== "string")
		) {
			throw new Error("Invalid session tree record");
		}
		if (typeof entry.id === "string") {
			if (ids.has(entry.id)) throw new Error(`Duplicate physical entry id: ${entry.id}`);
			ids.add(entry.id);
		}
		if (entry.type === "custom" && entry.customType === ACTIVE_SELECTION) {
			const selected = decodeSelection(entry.data).leafId;
			if (selected !== null && !treeIds.has(selected)) throw new Error(`Selection target not found: ${selected}`);
			continue;
		}
		if (entry.type === "custom" && entry.customType === EXTERNAL_HISTORY) decodeExternalHistory(entry.data);
		if (entry.type === "custom" && entry.customType === EXTERNAL_RECORD) {
			const key = recordKey(decodeExternal(entry.data));
			if (keys.has(key)) throw new Error(`Duplicate physical record key: ${key}`);
			keys.add(key);
		}
		if (typeof entry.id === "string") treeIds.add(entry.id);
	}
}

export function recordKey(record: ExternalRecord): string {
	return JSON.stringify(
		record.kind === "canonical"
			? [record.kind, record.recipientIdentity, record.eventId]
			: [record.kind, record.recipientIdentity, record.eventId, record.requestId],
	);
}

export function assertRecordSupport(value: unknown): asserts value is RecordStore {
	const store = value as Partial<RecordStore> | null;
	const capabilities = store?.recordCapabilities;
	if (
		!store ||
		!capabilities ||
		Object.entries(RECORD_CAPABILITIES).some(
			([key, expected]) => (capabilities as unknown as Record<string, unknown>)[key] !== expected,
		) ||
		[store?.isPersisted, store?.persistNow, store?.appendEntryOnce, store?.getEntryOnce].some(
			(method) => typeof method !== "function",
		)
	) {
		throw new Error("Goetia disabled: Install a pi build with durable-records/1; ordinary pi remains available.");
	}
	if (store.isPersisted?.() !== true) {
		throw new Error("Goetia disabled: --no-session cannot own a recoverable mailbox; start a saved session.");
	}
}
