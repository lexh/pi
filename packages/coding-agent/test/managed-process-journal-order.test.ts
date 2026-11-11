import { expect, test } from "vitest";
import type { ProcessJournalPage } from "../src/core/managed-process-types.ts";
import { fixture } from "./helpers/managed-process.ts";

test("finite replay keeps one latest attempt before every spawn and PID-less gap", async () => {
	const pages: ProcessJournalPage[] = [];
	const f = fixture({
		reconcile: async (page) => {
			pages.push(structuredClone(page));
			return { acknowledgedThrough: page.complete ? page.through : page.records.at(-1)!.sequence, cleanup: [] };
		},
	});
	const context = f.begin("offline-ended");
	await context.attempt.opening;
	const entry = f.registry.record(f.intent(context, "retained-spawn"), context, "kinfo:1000000")!;
	const firstOrdinal = entry.sequence;
	f.registry.released(entry);
	f.registry.callEnded(entry, context, false);
	f.registry.gap(context, "unsupported-tool");
	f.registry.end(context.attempt);
	const withoutSpawn = f.begin("gap-only");
	await withoutSpawn.attempt.opening;
	f.registry.gap(withoutSpawn, "custom-operations");
	f.registry.end(withoutSpawn.attempt);
	await f.registry.reconcile(f.adapter, {
		hostId: "host-one",
		credential: "test-only-secret",
		process: { pid: 44, birthNonce: "test-nonce" },
	});
	const records = pages.flatMap((page) => page.records);
	const attempts = records.filter((record) => record.kind === "attempt");
	expect(attempts).toHaveLength(2);
	expect(attempts.every((record) => record.kind === "attempt" && record.value.ended)).toBe(true);
	const introduced = new Set<string>();
	for (const record of records) {
		if (record.kind === "attempt") introduced.add(record.value.attemptId);
		else {
			const attemptId = record.kind === "spawn" ? record.value.intent.attemptId : record.value.attemptId;
			expect(introduced.has(attemptId)).toBe(true);
		}
	}
	const spawn = records.find((record) => record.kind === "spawn");
	expect(spawn?.sequence).toBe(firstOrdinal);
	expect(spawn?.kind === "spawn" && spawn.value.sequence).toBe(firstOrdinal);
	expect(f.registry.snapshot().entries[0].sequence).toBe(firstOrdinal);
	expect(pages.at(-1)!.through).toBeGreaterThan(records.at(-1)!.sequence);
});
