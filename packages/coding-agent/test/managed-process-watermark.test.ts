import { expect, test } from "vitest";
import type { ProcessJournalPage } from "../src/core/managed-process-types.ts";
import { deferred, fixture } from "./helpers/managed-process.ts";

const auth = { hostId: "host-one", credential: "private", process: { pid: 44, birthNonce: "nonce" } };
const ack = (page: ProcessJournalPage) => ({
	acknowledgedThrough: page.complete ? page.through : page.records.at(-1)!.sequence,
	cleanup: [],
});

test("target drain retries an older frozen image then covers the ended latch without changing retry bytes", async () => {
	const seen: ProcessJournalPage[] = [];
	let lose = true;
	const f = fixture({
		reconcile: async (page) => {
			seen.push(structuredClone(page));
			if (lose) {
				lose = false;
				throw new Error("response lost");
			}
			return ack(page);
		},
	});
	const context = f.begin("target");
	await context.attempt.opening;
	await expect(f.registry.reconcile(f.adapter, auth)).rejects.toThrow(/lost/);
	f.registry.end(context.attempt);
	const target = f.registry.captureAttemptVersion("target");
	const covered = await f.registry.reconcileAttempt(target, f.adapter, auth);
	expect(seen[0]).toEqual(seen[1]);
	expect(seen).toHaveLength(3);
	expect(seen[1].records[0].kind === "attempt" && seen[1].records[0].value.ended).toBe(false);
	expect(seen[2].records[0].kind === "attempt" && seen[2].records[0].value.ended).toBe(true);
	expect(covered.version).toBeGreaterThanOrEqual(target.version);
	expect(covered.through).toBe(seen[2].through);
	expect(Object.isFrozen(target)).toBe(true);
	expect(Object.isFrozen(covered)).toBe(true);
});

test("partial page ACK is not an acknowledged target image", async () => {
	const lastReached = deferred<void>();
	const release = deferred<void>();
	const f = fixture({
		reconcile: async (page) => {
			if (page.complete) {
				lastReached.resolve();
				await release.promise;
			}
			return ack(page);
		},
	});
	const context = f.begin("target");
	await context.attempt.opening;
	for (let n = 0; n < 40; n++) f.registry.record(f.intent(context, `root-${n}`), context, null);
	f.registry.end(context.attempt);
	const target = f.registry.captureAttemptVersion("target");
	let done = false;
	const pending = f.registry.reconcileAttempt(target, f.adapter, auth).then((value) => {
		done = true;
		return value;
	});
	await lastReached.promise;
	expect(f.registry.inspect().reconciledThrough).toBe(0);
	expect(done).toBe(false);
	release.resolve();
	const covered = await pending;
	expect(covered.through).toBeGreaterThanOrEqual(target.version);
});

test("cleanup receipt tombstones advance local through but never fake transmission", async () => {
	let frozenThrough = 0;
	const f = fixture({
		reconcile: async (page) => {
			frozenThrough = page.through;
			return {
				...ack(page),
				cleanup: [{ attemptId: "target", revision: 100, spawnIds: ["root"], verdict: "accounted" }],
			};
		},
	});
	const context = f.begin("target");
	await context.attempt.opening;
	f.registry.record(f.intent(context, "root"), context, null);
	f.registry.end(context.attempt);
	const target = f.registry.captureAttemptVersion("target");
	const covered = await f.registry.reconcileAttempt(target, f.adapter, auth);
	expect(covered.through).toBe(frozenThrough);
	expect(f.registry.through).toBeGreaterThan(covered.through);
	expect(f.registry.inspect().reconciledThrough).toBe(frozenThrough);
	expect(await f.registry.reconcileAttempt(target, f.adapter, auth)).toEqual(covered);
});

test("a continuously spawning sibling cannot prevent a complete target acknowledgement", async () => {
	const seen: ProcessJournalPage[] = [];
	let mutate = () => {};
	const f = fixture({
		reconcile: async (page) => {
			if (seen.length > 12) throw new Error("target drain incorrectly waits for global quiescence");
			seen.push(structuredClone(page));
			mutate();
			return ack(page);
		},
	});
	const targetContext = f.begin("target");
	const sibling = f.begin("sibling");
	await Promise.all([targetContext.attempt.opening, sibling.attempt.opening]);
	f.registry.end(targetContext.attempt);
	const target = f.registry.captureAttemptVersion("target");
	let n = 0;
	mutate = () => {
		f.registry.record(f.intent(sibling, `ongoing-${n++}`), sibling, null);
	};
	const covered = await f.registry.reconcileAttempt(target, f.adapter, auth);
	expect(seen).toHaveLength(1);
	expect(covered.through).toBe(seen[0].through);
	expect(f.registry.through).toBeGreaterThan(covered.through);
	expect(sibling.attempt.ended).toBe(false);
});
