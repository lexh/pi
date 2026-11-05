import {
	ADMISSION_MESSAGE,
	decodeExternal,
	decodeExternalHistory,
	EXTERNAL_HISTORY,
	EXTERNAL_RECORD,
	type ExternalHistory,
	type ExternalRecord,
} from "./durable-records.ts";
import { type CustomMessage, createCustomMessage } from "./messages.ts";
import type { SessionEntry } from "./session-manager.ts";

export type { AdmissionOrigin, ExternalHistory } from "./durable-records.ts";
export { ADMISSION_MESSAGE, decodeExternalHistory, EXTERNAL_HISTORY } from "./durable-records.ts";
export type { AdmissionEntry } from "./request-admission-types.ts";
export type ProjectableExternalRecord = ExternalRecord | ExternalHistory;

export function externalEventKey(record: ProjectableExternalRecord): string {
	return JSON.stringify([record.recipientIdentity, record.eventId]);
}

export function readExternalEntry(entry: SessionEntry): ProjectableExternalRecord | undefined {
	if (entry.type !== "custom") return undefined;
	if (entry.customType === EXTERNAL_RECORD) return decodeExternal(entry.data);
	if (entry.customType === EXTERNAL_HISTORY) return decodeExternalHistory(entry.data);
	return undefined;
}

export function externalEntryToMessage(entry: SessionEntry): CustomMessage | undefined {
	const record = readExternalEntry(entry);
	if (!record || record.kind === "canonical") return undefined;
	return createCustomMessage(
		ADMISSION_MESSAGE,
		record.envelope,
		false,
		{
			logicalKey: externalEventKey(record),
			sourceEntryId: entry.id,
			recipientIdentity: record.recipientIdentity,
			eventId: record.eventId,
			provenance: record.provenance,
			origin:
				record.kind === "inherited"
					? record.origin
					: {
							requestId: record.requestId,
							instanceId: record.instanceId,
							epoch: record.epoch,
							branchAnchor: record.branchAnchor,
						},
		},
		entry.timestamp,
	);
}
