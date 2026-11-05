import { ACTIVE_SELECTION, decodeExternalHistory, EXTERNAL_HISTORY, type ExternalHistory } from "./durable-records.ts";
import { readExternalEntry } from "./external-event-records.ts";
import type { SessionEntry } from "./session-manager.ts";

/** Copy admitted history without carrying a live mailbox or selection journal. */
export function copyExternalHistory(entries: readonly SessionEntry[], sourceSessionId: string): SessionEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const retained = new Set(
		entries
			.filter(
				(entry) =>
					!(entry.type === "custom" && entry.customType === ACTIVE_SELECTION) &&
					readExternalEntry(entry)?.kind !== "canonical",
			)
			.map((entry) => entry.id),
	);
	let changed: boolean;
	do {
		changed = false;
		for (const entry of entries) {
			if (entry.type === "label" && retained.has(entry.id) && !retained.has(entry.targetId)) {
				retained.delete(entry.id);
				changed = true;
			}
		}
	} while (changed);
	const nearest = (id: string | null): string | null => {
		const visited = new Set<string>();
		while (id !== null && !retained.has(id)) {
			if (visited.has(id)) return null;
			visited.add(id);
			id = byId.get(id)?.parentId ?? null;
		}
		return id;
	};
	return entries
		.filter((entry) => retained.has(entry.id))
		.map((entry): SessionEntry => {
			const parentId = nearest(entry.parentId);
			const record = readExternalEntry(entry);
			if (record && record.kind !== "canonical" && entry.type === "custom") {
				const history: ExternalHistory =
					record.kind === "inherited"
						? { ...record, copiedFrom: { sessionId: sourceSessionId, entryId: entry.id } }
						: {
								version: 1,
								kind: "inherited",
								recipientIdentity: record.recipientIdentity,
								eventId: record.eventId,
								envelope: record.envelope,
								provenance: record.provenance,
								origin: {
									sessionId: sourceSessionId,
									entryId: entry.id,
									requestId: record.requestId,
									instanceId: record.instanceId,
									epoch: record.epoch,
									branchAnchor: record.branchAnchor,
								},
								copiedFrom: { sessionId: sourceSessionId, entryId: entry.id },
							};
				return { ...entry, parentId, customType: EXTERNAL_HISTORY, data: decodeExternalHistory(history) };
			}
			if (entry.type === "compaction" && !retained.has(entry.firstKeptEntryId)) {
				const path: SessionEntry[] = [];
				let current: SessionEntry | undefined = entry;
				while (current) {
					path.push(current);
					current = current.parentId ? byId.get(current.parentId) : undefined;
				}
				path.reverse();
				const index = path.findIndex((item) => item.id === entry.firstKeptEntryId);
				const boundary = index < 0 ? undefined : path.slice(index).find((item) => retained.has(item.id));
				return { ...entry, parentId, firstKeptEntryId: boundary?.id ?? entry.id };
			}
			if (entry.type === "branch_summary" && !retained.has(entry.fromId))
				return { ...entry, parentId, fromId: nearest(entry.fromId) ?? "root" };
			return { ...entry, parentId };
		});
}
