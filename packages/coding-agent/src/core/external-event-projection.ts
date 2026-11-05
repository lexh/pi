import { externalEventKey, type ProjectableExternalRecord, readExternalEntry } from "./external-event-records.ts";
import type { SessionEntry } from "./session-manager.ts";

export interface ExternalEventDisposition {
	recipientIdentity: string;
	eventId: string;
	state: "pending" | "read" | "expired" | "dropped";
	expiresAt: number | null;
	reason: string | null;
}
export interface ExternalEventViewState {
	revision: number;
	verified: boolean;
	dispositions: ReadonlyMap<string, ExternalEventDisposition>;
}
export interface ExternalEventCard {
	type: "external_event";
	key: string;
	sourceEntryId: string;
	canonicalEntryId?: string;
	record: ProjectableExternalRecord;
	state: "unverified" | "pending" | "read" | "expired" | "dropped" | "admitted" | "inherited";
	verified: boolean;
	reason: string | null;
	location: "inline" | "shelf";
}
export type ExternalEventDisplayItem = { type: "entry"; entry: SessionEntry } | ExternalEventCard;
export interface ExternalEventDisplayInput {
	allEntries: readonly SessionEntry[];
	activeBranchEntries: readonly SessionEntry[];
	visibleEntries: readonly SessionEntry[];
	state: ExternalEventViewState;
	now: number;
}

export function buildExternalEventDisplay(input: ExternalEventDisplayInput): ExternalEventDisplayItem[] {
	const canonicals = new Map<string, { entry: SessionEntry; record: ProjectableExternalRecord }>();
	const localAdmissions = new Set<string>();
	const activeAdmissions = new Set<string>();
	const visibleCanonicals = new Set<string>();
	const winners = new Map<string, string>();
	for (const entry of input.allEntries) {
		const record = readExternalEntry(entry);
		if (!record) continue;
		const key = externalEventKey(record);
		if (record.kind === "canonical") canonicals.set(key, { entry, record });
		else localAdmissions.add(key);
	}
	for (const entry of input.activeBranchEntries) {
		const record = readExternalEntry(entry);
		if (record && record.kind !== "canonical") activeAdmissions.add(externalEventKey(record));
	}
	for (const entry of input.visibleEntries) {
		const record = readExternalEntry(entry);
		if (!record) continue;
		const key = externalEventKey(record);
		if (record.kind === "canonical") visibleCanonicals.add(key);
		else winners.set(key, entry.id);
	}
	const result: ExternalEventDisplayItem[] = [];
	for (const entry of input.visibleEntries) {
		const record = readExternalEntry(entry);
		if (!record) {
			result.push({ type: "entry", entry });
			continue;
		}
		const key = externalEventKey(record);
		if (record.kind === "canonical" || winners.get(key) !== entry.id) continue;
		const canonical = canonicals.get(key);
		result.push({
			type: "external_event",
			key,
			sourceEntryId: entry.id,
			...(canonical ? { canonicalEntryId: canonical.entry.id } : {}),
			record,
			state: record.kind === "inherited" ? "inherited" : "admitted",
			verified: true,
			reason: null,
			location: "inline",
		});
	}
	for (const [key, { entry, record }] of canonicals) {
		if (winners.has(key) || activeAdmissions.has(key)) continue;
		const elsewhere = localAdmissions.has(key);
		if (elsewhere && !visibleCanonicals.has(key)) continue;
		const disposition = input.state.dispositions.get(key);
		let state: ExternalEventCard["state"] = disposition?.state ?? "unverified";
		let verified = input.state.verified && disposition !== undefined;
		let reason = disposition?.reason ?? null;
		if (disposition?.state === "pending" && disposition.expiresAt !== null && disposition.expiresAt <= input.now) {
			state = "expired";
			verified = false;
		}
		if (elsewhere) {
			state = "read";
			verified = true;
			reason = "Admitted on another branch; this view does not admit it";
		}
		result.push({
			type: "external_event",
			key,
			sourceEntryId: entry.id,
			canonicalEntryId: entry.id,
			record,
			state,
			verified,
			reason,
			location: "shelf",
		});
	}
	return result;
}
