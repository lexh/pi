import { expect, test, vi } from "vitest";
import { parseLocalBirth } from "../src/core/managed-process-birth.ts";
import type * as ManagedContextModule from "../src/core/managed-process-context.ts";
import { currentManagedCall, withManagedCall } from "../src/core/managed-process-context.ts";
import { deferred, fixture } from "./helpers/managed-process.ts";

test("return, retirement and uncertain receipts retain the original root", async () => {
	const f = fixture();
	const context = f.begin("attempt-one");
	await context.attempt.opening;
	const intent = f.intent(context, "spawn-one");
	const entry = f.registry.record(intent, context, "kinfo:1000000")!;
	f.registry.callEnded(entry, context, true);
	f.registry.retireRuntime("instance-one");
	f.registry.accounted({
		attemptId: intent.attemptId,
		revision: 12,
		spawnIds: [intent.spawnId],
		verdict: "uncertain",
	});
	expect(f.registry.snapshot().entries).toHaveLength(1);
	f.registry.accounted({
		attemptId: intent.attemptId,
		revision: 13,
		spawnIds: [intent.spawnId],
		verdict: "accounted",
	});
	expect(f.registry.snapshot().entries).toHaveLength(0);
	expect(f.registry.snapshot().tombstones[0].intent).toEqual(intent);
	f.registry.accounted({
		attemptId: intent.attemptId,
		revision: 11,
		spawnIds: [intent.spawnId],
		verdict: "uncertain",
	});
	expect(f.registry.snapshot().entries).toHaveLength(0);
	expect(() => f.registry.record({ ...intent, pid: 42 }, context, null)).toThrow(/conflict/);
	expect(() =>
		f.registry.accounted({ attemptId: intent.attemptId, revision: 14, spawnIds: ["foreign"], verdict: "accounted" }),
	).toThrow(/Foreign/);
});

test("parallel reverse completions never relabel original call context", async () => {
	const f = fixture();
	const a = f.begin("a");
	const b = f.begin("b", "instance-two");
	const first = deferred<void>();
	const second = deferred<void>();
	const run = (context: typeof a, wait: Promise<void>) =>
		withManagedCall(context, async () => {
			await wait;
			const captured = currentManagedCall()!;
			f.registry.record(f.intent(captured), captured, null);
		});
	const x = run(a, first.promise);
	const y = run(b, second.promise);
	second.resolve();
	await y;
	first.resolve();
	await x;
	const entries = f.registry.snapshot().entries;
	expect(entries.map((e) => [e.intent.attemptId, e.intent.toolCallId, e.provenance.instanceId])).toEqual([
		["b", "tool-b", "instance-two"],
		["a", "tool-a", "instance-one"],
	]);
});

test("actual module reload shares ALS without relabeling a pending invocation", async () => {
	const f = fixture();
	const context = f.begin("before-reload");
	const release = deferred<void>();
	const pending = withManagedCall(context, async () => {
		await release.promise;
		const reloaded = await vi.importActual<typeof ManagedContextModule>("../src/core/managed-process-context.ts");
		expect(reloaded.currentManagedCall()).toBe(context);
		expect(reloaded.currentManagedCall()!.toolCallId).toBe("tool-before-reload");
	});
	vi.resetModules();
	release.resolve();
	await pending;
	expect(Object.isFrozen(context.attempt.intent.provenance.conversation)).toBe(true);
});

test("fixed replay pages retry unchanged and exclude authentication", async () => {
	const seen: string[] = [];
	let fail = true;
	const f = fixture({
		reconcile: async (page, auth) => {
			expect(auth.credential).toBe("private-credential");
			seen.push(JSON.stringify(page));
			if (fail) {
				fail = false;
				throw new Error("response lost");
			}
			return { acknowledgedThrough: page.complete ? page.through : page.records.at(-1)!.sequence, cleanup: [] };
		},
	});
	const context = f.begin("offline");
	for (let i = 0; i < 35; i++) f.registry.record(f.intent(context, `spawn-${i}`), context, null);
	const auth = { hostId: "host-one", credential: "private-credential", process: { pid: 44, birthNonce: "nonce" } };
	await expect(f.registry.reconcile(f.adapter, auth)).rejects.toThrow(/lost/);
	f.registry.record(f.intent(context, "later"), context, null);
	await f.registry.reconcile(f.adapter, auth);
	expect(seen[0]).toBe(seen[1]);
	expect(seen.join()).not.toMatch(/private-credential|private-token|generationToken|adapter/);
	expect(seen.slice(1).join()).not.toContain('"spawnId":"later"');
	await f.registry.reconcile(f.adapter, auth);
	expect(seen.at(-1)).toContain('"spawnId":"later"');
});

test("journal overflow never evicts unresolved roots", () => {
	const f = fixture();
	const context = f.begin("overflow");
	for (let i = 0; i < 4096; i++) f.registry.record(f.intent(context, `s-${i}`), context, null);
	expect(f.registry.record(f.intent(context, "excess"), context, null)).toBeUndefined();
	expect(f.registry.snapshot().entries).toHaveLength(4096);
	expect(f.registry.inspect().gaps).toContain("journal-overflow");
	expect(f.registry.accepting).toBe(false);
});

test("stop ACK is synchronous, target scoped and waits only after the service can signal", async () => {
	const f = fixture();
	const a = f.begin("a");
	const b = f.begin("b");
	const exited = deferred<void>();
	let closed = false;
	let aborted = false;
	a.attempt.gates.add(() => {
		closed = true;
	});
	a.attempt.activities.add(exited.promise);
	const ack = f.registry.requestStop("a", "stop-a", async () => {
		aborted = true;
	});
	expect(ack.requested).toBe(true);
	expect(closed).toBe(true);
	expect(a.attempt.stopping).toBe(true);
	expect(b.attempt.stopping).toBe(false);
	let settled = false;
	void ack.settled.then(() => {
		settled = true;
	});
	await Promise.resolve();
	expect(aborted).toBe(true);
	expect(settled).toBe(false);
	expect(f.registry.requestStop("a", "stop-a", async () => {}).settled).toBe(ack.settled);
	a.attempt.activities.delete(exited.promise);
	exited.resolve();
	await ack.settled;
	expect(a.attempt.ended).toBe(true);
});

test("a new confirmed service stop reuses the same attempt latch before and after settlement", async () => {
	const f = fixture();
	const context = f.begin("retry-target");
	await context.attempt.opening;
	const release = deferred<void>();
	let aborts = 0;
	let cancellations = 0;
	let reentrant: Promise<void> | undefined;
	context.attempt.gates.add(() => {
		cancellations++;
		reentrant = f.registry.requestStop("retry-target", "reentrant-confirmed", async () => {
			aborts++;
		}).settled;
	});
	const first = f.registry.requestStop("retry-target", "first-uncertain", async () => {
		aborts++;
		await release.promise;
	});
	const same = f.registry.requestStop("retry-target", "first-uncertain", async () => {
		aborts++;
	});
	const second = f.registry.requestStop("retry-target", "second-confirmed", async () => {
		aborts++;
	});
	expect(reentrant).toBe(first.settled);
	expect(same.settled).toBe(first.settled);
	expect(second.settled).toBe(first.settled);
	expect(second.requested).toBe(true);
	expect(cancellations).toBe(1);
	await Promise.resolve();
	expect(aborts).toBe(1);
	release.resolve();
	await first.settled;
	const third = f.registry.requestStop("retry-target", "after-settled", async () => {
		aborts++;
	});
	expect(third.settled).toBe(first.settled);
	await third.settled;
	expect(aborts).toBe(1);
	expect(context.attempt.ended).toBe(true);
	expect(() => f.registry.requestStop("foreign", "second-confirmed", async () => {})).toThrow(/not retained/);
});

test("local native parser rejects short layout, wrong PID and invalid microseconds", () => {
	const buffer = Buffer.alloc(648);
	buffer.writeBigInt64LE(2n, 0);
	buffer.writeInt32LE(9, 8);
	buffer.writeInt32LE(41, 40);
	expect(parseLocalBirth(buffer, 648n, 41)).toBe("kinfo:2000009");
	expect(parseLocalBirth(buffer, 647n, 41)).toBeNull();
	expect(parseLocalBirth(buffer, 648n, 42)).toBeNull();
	buffer.writeInt32LE(1_000_000, 8);
	expect(parseLocalBirth(buffer, 648n, 41)).toBeNull();
});
