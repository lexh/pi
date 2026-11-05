import { describe, expect, it, vi } from "vitest";
import { RuntimeHost } from "../src/core/runtime-host.ts";
import type { HostRuntimeReceipt, RuntimeExchange } from "../src/core/runtime-lifecycle-types.ts";
import { savedFixture } from "./helpers/external-events.ts";
import { FakeRuntimeCoordinator } from "./helpers/fake-runtime-coordinator.ts";

const binding = (name: string) => () => ({ piSessionId: name, sessionFile: `/${name}` });

describe("runtime reconciliation", () => {
	it("coalesces offline replacements without replaying intermediate attachments", async () => {
		const fake = new FakeRuntimeCoordinator();
		const host = new RuntimeHost();
		const f = savedFixture();
		const resolve = () => ({ piSessionId: f.manager.getSessionId(), sessionFile: f.manager.persistNow() });
		const a = host.open(resolve);
		try {
			a.participate();
			await a.reconcile(fake.exchange);
			const old = a.capture();
			fake.watchExit(old, "watch-a");
			fake.disconnect();
			a.disconnect();
			a.retire("reload");
			const b = host.open(resolve);
			b.participate();
			b.retire("reload");
			const c = host.open(resolve);
			c.participate();
			fake.reconnect();
			await c.reconcile(fake.exchange);
			const current = c.capture();
			expect(current.mailboxId).toBe(old.mailboxId);
			expect(current.instanceId).not.toBe(old.instanceId);
			expect(current.generation).toBeGreaterThan(old.generation);
			expect(fake.attachmentFor(old.mailboxId)?.instanceId).toBe(current.instanceId);
			expect(fake.exitResult("watch-a")).toEqual({ reason: "runtime-detached" });
			expect(() => fake.operate(old, "stale-status", "status")).toThrow(/stale/);
			c.retire("quit");
		} finally {
			f.cleanup();
		}
	});
	it("shares raw calls but applies each caller independently", async () => {
		const fake = new FakeRuntimeCoordinator();
		const host = new RuntimeHost();
		const a = host.open(binding("a"));
		const b = host.open(binding("b"));
		a.participate();
		b.participate();
		const gate = fake.holdNextExchange();
		const first = a.reconcile(fake.exchange);
		const second = b.reconcile(fake.exchange);
		await gate.received;
		gate.commit();
		await gate.committed;
		gate.respond();
		expect(await first).toBe("applied");
		expect(await second).toBe("applied");
		expect(a.capture().mailboxId).not.toBe(b.capture().mailboxId);
		const fence = a.capture();
		expect(await a.reconcile(fake.exchange)).toBe("applied");
		expect(a.isCurrent(fence)).toBe(true);
	});
	it("does not discard a live caller when an unrelated scope changes", async () => {
		const fake = new FakeRuntimeCoordinator();
		const host = new RuntimeHost();
		const a = host.open(binding("a"));
		a.participate();
		const gate = fake.holdNextExchange();
		const pending = a.reconcile(fake.exchange);
		await gate.received;
		gate.commit();
		await gate.committed;
		const b = host.open(binding("b"));
		b.participate();
		gate.respond();
		expect(await pending).toBe("applied");
		expect(a.capture().instanceId).toBe(a.inspect().instanceId);
	});
	it("supersedes an older image rejected after the newer image commits", async () => {
		const host = new RuntimeHost();
		const fake = new FakeRuntimeCoordinator();
		const a = host.open(binding("a"));
		a.participate();
		const gate = fake.holdNextExchange();
		const old = a.reconcile(fake.exchange);
		await gate.received;
		const b = host.open(binding("b"));
		b.participate();
		expect(await a.reconcile(fake.exchange)).toBe("applied");
		const fence = a.capture();
		gate.commit();
		await expect(gate.committed).rejects.toThrow(/Stale/);
		expect(await old).toBe("superseded");
		expect(a.isCurrent(fence)).toBe(true);
	});
	it("supersedes an old successful response after a newer attachment", async () => {
		const host = new RuntimeHost();
		const fake = new FakeRuntimeCoordinator();
		const a = host.open(binding("a"));
		a.participate();
		const gate = fake.holdNextExchange();
		const old = a.reconcile(fake.exchange);
		await gate.received;
		gate.commit();
		await gate.committed;
		const b = host.open(binding("b"));
		b.participate();
		expect(await a.reconcile(fake.exchange)).toBe("applied");
		const current = a.capture();
		gate.respond();
		expect(await old).toBe("superseded");
		expect(a.isCurrent(current)).toBe(true);
	});
	it("keeps A current when B is cancelled or retired while A waits", async () => {
		for (const action of ["cancel", "retire"] as const) {
			const host = new RuntimeHost();
			const fake = new FakeRuntimeCoordinator();
			const a = host.open(binding("a"));
			const b = host.open(binding("b"));
			a.participate();
			b.participate();
			const gate = fake.holdNextExchange();
			const waiting = a.reconcile(fake.exchange);
			await gate.received;
			gate.commit();
			await gate.committed;
			if (action === "cancel") b.cancel();
			else b.retire("quit");
			gate.respond();
			expect(await waiting).toBe("applied");
			expect(a.capture().instanceId).toBe(a.inspect().instanceId);
		}
	});
	it("supersedes old failures and malformed responses after a newer success", async () => {
		for (const malformed of [false, true]) {
			const host = new RuntimeHost();
			const fake = new FakeRuntimeCoordinator();
			const a = host.open(binding("a"));
			a.participate();
			const gate = Promise.withResolvers<HostRuntimeReceipt>();
			let calls = 0;
			const exchange: RuntimeExchange = (image, auth) => (++calls === 1 ? gate.promise : fake.exchange(image, auth));
			const old = a.reconcile(exchange);
			const b = host.open(binding("b"));
			b.participate();
			expect(await a.reconcile(exchange)).toBe("applied");
			const fence = a.capture();
			if (malformed) gate.resolve({} as HostRuntimeReceipt);
			else gate.reject(new Error("late"));
			expect(await old).toBe("superseded");
			expect(a.isCurrent(fence)).toBe(true);
		}
	});
	it("returns independent attached and refused results in either caller order", async () => {
		for (const reverse of [false, true]) {
			const host = new RuntimeHost();
			const fake = new FakeRuntimeCoordinator();
			const a = host.open(binding("same"));
			const b = host.open(binding("same"));
			a.participate();
			await a.reconcile(fake.exchange);
			b.participate();
			const gate = fake.holdNextExchange();
			const first = (reverse ? b : a).reconcile(fake.exchange);
			const second = (reverse ? a : b).reconcile(fake.exchange);
			await gate.received;
			gate.commit();
			await gate.committed;
			gate.respond();
			expect(await first).toBe(reverse ? "refused" : "applied");
			expect(await second).toBe(reverse ? "applied" : "refused");
			expect(a.capture().instanceId).toBe(a.inspect().instanceId);
			expect(b.inspect().state).toBe("refused");
		}
	});
	it("retries a committed lost response and preserves healthy refresh fences", async () => {
		const host = new RuntimeHost();
		const fake = new FakeRuntimeCoordinator();
		const a = host.open(binding("a"));
		a.participate();
		const gate = fake.holdNextExchange();
		const pending = a.reconcile(fake.exchange);
		const rejected = expect(pending).rejects.toThrow("lost");
		await gate.received;
		gate.commit();
		await gate.committed;
		gate.rejectResponse(new Error("lost"));
		await rejected;
		expect(await a.reconcile(fake.exchange)).toBe("applied");
		const fence = a.capture();
		expect(await a.reconcile(fake.exchange)).toBe("applied");
		expect(a.isCurrent(fence)).toBe(true);
	});
	it("isolates exchanges and prevents route reuse from reviving fences", async () => {
		const host = new RuntimeHost();
		const fake = new FakeRuntimeCoordinator();
		const a = host.open(binding("a"));
		const b = host.open(binding("b"));
		a.participate();
		b.participate();
		const ex: RuntimeExchange = (image, auth) => fake.exchange(image, auth);
		const ey: RuntimeExchange = (image, auth) => fake.exchange(image, auth);
		await a.reconcile(ex);
		const first = a.capture();
		await b.reconcile(ey);
		const bFence = b.capture();
		await a.reconcile(ey);
		expect(a.isCurrent(first)).toBe(false);
		await a.reconcile(ex);
		expect(a.isCurrent(first)).toBe(false);
		expect(b.isCurrent(bFence)).toBe(true);
		const gate = fake.holdNextExchange();
		const hung = a.reconcile(ex);
		await gate.received;
		expect(await b.reconcile(ey)).toBe("applied");
		expect(b.isCurrent(bFence)).toBe(true);
		gate.commit();
		await gate.committed;
		gate.respond();
		expect(await hung).toBe("applied");
	});
	it("invalidates a failed connection once and rejects all current shared waiters", async () => {
		const host = new RuntimeHost();
		const fake = new FakeRuntimeCoordinator();
		const a = host.open(binding("a"));
		const b = host.open(binding("b"));
		a.participate();
		b.participate();
		let fail = false;
		const ready = Promise.withResolvers<void>();
		const deferred = Promise.withResolvers<HostRuntimeReceipt>();
		const exchange: RuntimeExchange = (image, auth) => {
			if (!fail) return fake.exchange(image, auth);
			ready.resolve();
			return deferred.promise;
		};
		await a.reconcile(exchange);
		await b.reconcile(exchange);
		const old = a.capture();
		fail = true;
		const one = a.reconcile(exchange);
		const two = b.reconcile(exchange);
		const e1 = expect(one).rejects.toThrow("broken");
		const e2 = expect(two).rejects.toThrow("broken");
		await ready.promise;
		deferred.reject(new Error("broken"));
		await Promise.all([e1, e2]);
		expect(a.isCurrent(old)).toBe(false);
		fail = false;
		await a.reconcile(exchange);
		expect(a.isCurrent(old)).toBe(false);
	});
	it("keeps unrelated success across cross-route refusal cleanup in both orders", async () => {
		for (const reverse of [false, true]) {
			const host = new RuntimeHost();
			const fake = new FakeRuntimeCoordinator();
			const a = host.open(binding("same"));
			const b = host.open(binding("same"));
			a.participate();
			await a.reconcile(fake.exchange);
			b.participate();
			const receivedX = Promise.withResolvers<HostRuntimeReceipt>();
			const receivedY = Promise.withResolvers<HostRuntimeReceipt>();
			const responseX = Promise.withResolvers<HostRuntimeReceipt>();
			const responseY = Promise.withResolvers<HostRuntimeReceipt>();
			const ex: RuntimeExchange = async (image, auth) => {
				receivedX.resolve(await fake.exchange(image, auth));
				return responseX.promise;
			};
			const ey: RuntimeExchange = async (image, auth) => {
				receivedY.resolve(await fake.exchange(image, auth));
				return responseY.promise;
			};
			const pendingA = a.reconcile(ex);
			const pendingB = b.reconcile(ey);
			const [receiptX, receiptY] = await Promise.all([receivedX.promise, receivedY.promise]);
			if (reverse) {
				responseY.resolve(receiptY);
				expect(await pendingB).toBe("refused");
				responseX.resolve(receiptX);
				expect(await pendingA).toBe("applied");
			} else {
				responseX.resolve(receiptX);
				expect(await pendingA).toBe("applied");
				responseY.resolve(receiptY);
				expect(await pendingB).toBe("refused");
			}
			expect(a.capture().instanceId).toBe(a.inspect().instanceId);
		}
	});
	it("does not let an old refusal remove an explicit newer retry", async () => {
		const host = new RuntimeHost();
		const fake = new FakeRuntimeCoordinator();
		const a = host.open(binding("same"));
		const b = host.open(binding("same"));
		a.participate();
		await a.reconcile(fake.exchange);
		b.participate();
		const received = Promise.withResolvers<HostRuntimeReceipt>();
		const held = Promise.withResolvers<HostRuntimeReceipt>();
		const ey: RuntimeExchange = async (image, auth) => {
			received.resolve(await fake.exchange(image, auth));
			return held.promise;
		};
		const old = b.reconcile(ey);
		const oldReceipt = await received.promise;
		expect(await a.reconcile(fake.exchange)).toBe("applied");
		expect(b.inspect().state).toBe("refused");
		b.participate();
		const revision = host.getDesiredImage().revision;
		held.resolve(oldReceipt);
		expect(await old).toBe("superseded");
		expect(host.getDesiredImage().revision).toBe(revision);
		expect(b.inspect().state).toBe("pending");
	});
	it("cancels a delayed response before it can install verification", async () => {
		const host = new RuntimeHost();
		const fake = new FakeRuntimeCoordinator();
		const a = host.open(binding("a"));
		a.participate();
		const gate = fake.holdNextExchange();
		const waiting = a.reconcile(fake.exchange);
		await gate.received;
		gate.commit();
		await gate.committed;
		a.cancel();
		gate.respond();
		expect(await waiting).toBe("superseded");
		expect(() => a.capture()).toThrow();
		expect(a.inspect().epoch).toBe(1);
	});
	it("validates every receipt field before mutation and isolates protocol failure to its route", async () => {
		const corruptions: Array<(receipt: HostRuntimeReceipt) => unknown> = [
			(r) => ({ ...r, version: 2 }),
			(r) => ({ ...r, hostId: "wrong" }),
			(r) => ({ ...r, operationId: "wrong" }),
			(r) => ({ ...r, revision: r.revision + 1 }),
			(r) => ({ ...r, results: r.results.slice(0, 1) }),
			(r) => ({ ...r, results: [r.results[0], r.results[0]] }),
			(r) => ({ ...r, results: [...r.results, r.results[0]] }),
			...(["incarnation", "epoch", "paneId", "mailboxId", "generationToken", "generation"] as const).flatMap(
				(key) => {
					const values: unknown[] =
						key === "generation"
							? [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]
							: key === "mailboxId" || key === "generationToken"
								? ["", 42]
								: key === "paneId"
									? ["wrong"]
									: [99];
					return values.map((value) => (r: HostRuntimeReceipt) => ({
						...r,
						results: r.results.map((result, i) =>
							i === 1 && result.status === "attached"
								? { ...result, attachment: { ...result.attachment, [key]: value } }
								: result,
						),
					}));
				},
			),
			(r) => ({
				...r,
				results: r.results.map((result, i) =>
					i === 1 && result.status === "attached"
						? {
								...result,
								attachment: {
									...result.attachment,
									conversation: { ...result.attachment.conversation, sessionFile: "/wrong" },
								},
							}
						: result,
				),
			}),
			(r) => ({
				...r,
				results: r.results.map((result, i) =>
					i === 1 && result.status === "attached"
						? { status: "refused", runtime: result.attachment, reason: "unsupported" }
						: result,
				),
			}),
		];
		for (const corrupt of corruptions) {
			const host = new RuntimeHost();
			const fake = new FakeRuntimeCoordinator();
			const a = host.open(binding("a"));
			const b = host.open(binding("b"));
			a.participate();
			b.participate();
			let broken = false;
			const ex: RuntimeExchange = async (image, auth) => {
				const receipt = await fake.exchange(image, auth);
				return broken ? (corrupt(receipt) as HostRuntimeReceipt) : receipt;
			};
			const ey: RuntimeExchange = (image, auth) => fake.exchange(image, auth);
			await a.reconcile(ex);
			await b.reconcile(ey);
			const aFence = a.capture();
			const bFence = b.capture();
			broken = true;
			await expect(a.reconcile(ex)).rejects.toThrow();
			expect(a.isCurrent(aFence)).toBe(false);
			expect(b.isCurrent(bFence)).toBe(true);
		}
	});
	it("rejects every current shared caller with the same protocol error", async () => {
		const host = new RuntimeHost();
		const a = host.open(binding("a"));
		const b = host.open(binding("b"));
		a.participate();
		b.participate();
		const received = Promise.withResolvers<void>();
		const response = Promise.withResolvers<HostRuntimeReceipt>();
		const exchange: RuntimeExchange = () => {
			received.resolve();
			return response.promise;
		};
		const first = a.reconcile(exchange);
		const second = b.reconcile(exchange);
		const firstError = first.catch((error) => error);
		const secondError = second.catch((error) => error);
		await received.promise;
		response.resolve({} as HostRuntimeReceipt);
		const [one, two] = await Promise.all([firstError, secondError]);
		expect(one).toBeInstanceOf(Error);
		expect(two).toBe(one);
	});
	it("supersedes an affected shared waiter that starts a newer route during failure", async () => {
		for (const malformed of [true, false]) {
			const host = new RuntimeHost();
			const fake = new FakeRuntimeCoordinator();
			const a = host.open(binding("a"));
			const b = host.open(binding("b"));
			a.participate();
			b.participate();
			let broken = false;
			const response = Promise.withResolvers<HostRuntimeReceipt>();
			const received = Promise.withResolvers<void>();
			const ex: RuntimeExchange = (image, auth) => {
				if (!broken) return fake.exchange(image, auth);
				received.resolve();
				return response.promise;
			};
			const ey: RuntimeExchange = (image, auth) => fake.exchange(image, auth);
			await a.reconcile(ex);
			await b.reconcile(ex);
			broken = true;
			let newer: Promise<"applied" | "superseded" | "refused"> | undefined;
			const original = b.invalidateConnection.bind(b);
			const spy = vi.spyOn(b, "invalidateConnection").mockImplementation((id, serial) => {
				original(id, serial);
				newer = b.reconcile(ey);
			});
			try {
				const first = a.reconcile(ex);
				const second = b.reconcile(ex);
				const firstError = expect(first).rejects.toThrow(
					malformed ? /Invalid runtime receipt/ : /transport failure/,
				);
				await received.promise;
				if (malformed) response.resolve({} as HostRuntimeReceipt);
				else response.reject(new Error("transport failure"));
				await firstError;
				expect(await second).toBe("superseded");
				expect(newer).toBeDefined();
				expect(await newer).toBe("applied");
				expect(b.capture().instanceId).toBe(b.inspect().instanceId);
			} finally {
				spy.mockRestore();
			}
		}
	});
	it("fails closed on attempt, verification and connection counter exhaustion", async () => {
		for (const kind of ["attempt", "verification", "connection"] as const) {
			const counters =
				kind === "attempt" ? { attempt: Number.MAX_SAFE_INTEGER - 1 } : { [kind]: Number.MAX_SAFE_INTEGER };
			const host = new RuntimeHost({ initialCounters: counters });
			const fake = new FakeRuntimeCoordinator();
			const scope = host.open(binding("a"));
			scope.participate();
			await scope.reconcile(fake.exchange);
			const fence = scope.capture();
			const revoked: string[] = [];
			scope.track(fence, { kind: "wait", id: "w", revoke: (reason) => revoked.push(reason) });
			if (kind === "attempt") await expect(scope.reconcile(fake.exchange)).rejects.toThrow(/exhausted/);
			else expect(() => scope.disconnect()).toThrow(/exhausted/);
			expect(scope.isCurrent(fence)).toBe(false);
			expect(scope.inspect().state).toBe("retired");
			expect(revoked).toEqual(["runtime-detached"]);
			if (kind !== "connection") expect(host.getDesiredImage().runtimes).toHaveLength(0);
		}
	});
	it("disables the host and drains live scopes when incarnation allocation exhausts", async () => {
		const host = new RuntimeHost({ initialCounters: { incarnation: Number.MAX_SAFE_INTEGER - 1 } });
		const fake = new FakeRuntimeCoordinator();
		const scope = host.open(binding("a"));
		scope.participate();
		await scope.reconcile(fake.exchange);
		const fence = scope.capture();
		const revoked: string[] = [];
		scope.track(fence, { kind: "wait", id: "w", revoke: (reason) => revoked.push(reason) });
		expect(() => host.open(binding("b"))).toThrow(/exhausted/);
		expect(scope.isCurrent(fence)).toBe(false);
		expect(revoked).toEqual(["runtime-detached"]);
		await expect(scope.reconcile(fake.exchange)).rejects.toThrow(/unavailable/);
	});
	it("does not transmit an obsolete image after revision exhaustion", async () => {
		const host = new RuntimeHost({ initialCounters: { revision: Number.MAX_SAFE_INTEGER - 1 } });
		const scope = host.open(binding("a"));
		scope.participate();
		expect(() => scope.cancel()).toThrow(/exhausted/);
		let calls = 0;
		const exchange: RuntimeExchange = async () => {
			calls++;
			throw new Error("unexpected");
		};
		await expect(scope.reconcile(exchange)).rejects.toThrow(/unavailable/);
		expect(calls).toBe(0);
	});
	it("does not let an inactive caller disconnect a newer route", async () => {
		const host = new RuntimeHost();
		const fake = new FakeRuntimeCoordinator();
		const a = host.open(binding("a"));
		const b = host.open(binding("b"));
		a.participate();
		b.participate();
		await a.reconcile(fake.exchange);
		a.disconnect();
		await b.reconcile(fake.exchange);
		const fence = b.capture();
		a.disconnect();
		expect(b.isCurrent(fence)).toBe(true);
	});
	it("keeps an independent route healthy on explicit disconnect", async () => {
		const host = new RuntimeHost();
		const fake = new FakeRuntimeCoordinator();
		const a = host.open(binding("a"));
		const b = host.open(binding("b"));
		a.participate();
		b.participate();
		const ex: RuntimeExchange = (image, auth) => fake.exchange(image, auth);
		const ey: RuntimeExchange = (image, auth) => fake.exchange(image, auth);
		await a.reconcile(ex);
		await b.reconcile(ey);
		const fence = b.capture();
		a.disconnect();
		expect(b.isCurrent(fence)).toBe(true);
	});
	it("treats a rejection after explicit disconnect as superseded", async () => {
		const host = new RuntimeHost();
		const scope = host.open(binding("a"));
		scope.participate();
		const received = Promise.withResolvers<void>();
		const response = Promise.withResolvers<HostRuntimeReceipt>();
		const exchange: RuntimeExchange = () => {
			received.resolve();
			return response.promise;
		};
		const pending = scope.reconcile(exchange);
		await received.promise;
		scope.disconnect();
		response.reject(new Error("late"));
		expect(await pending).toBe("superseded");
	});
	it("ignores disconnect from a retired predecessor", async () => {
		const host = new RuntimeHost();
		const fake = new FakeRuntimeCoordinator();
		const a = host.open(binding("a"));
		a.participate();
		await a.reconcile(fake.exchange);
		a.retire("reload");
		const b = host.open(binding("a"));
		b.participate();
		await b.reconcile(fake.exchange);
		const fence = b.capture();
		a.disconnect();
		expect(b.isCurrent(fence)).toBe(true);
	});
	it("supersedes host flush on image change or an equal accepted receipt", async () => {
		for (const change of [true, false]) {
			const host = new RuntimeHost();
			const fake = new FakeRuntimeCoordinator();
			const a = host.open(binding("a"));
			a.participate();
			const flush = host.open(() => {
				throw new Error("resolver must stay lazy");
			});
			const gate = fake.holdNextExchange();
			const active = change ? undefined : a.reconcile(fake.exchange);
			const pending = flush.reconcile(fake.exchange);
			await gate.received;
			gate.commit();
			await gate.committed;
			if (change) {
				const b = host.open(binding("b"));
				b.participate();
			}
			gate.respond();
			if (active) expect(await active).toBe("applied");
			expect(await pending).toBe("superseded");
			expect(flush.inspect().state).toBe("unregistered");
		}
	});
	it("does not supersede a reply for unused scope allocation and retirement", async () => {
		const host = new RuntimeHost();
		const fake = new FakeRuntimeCoordinator();
		const a = host.open(binding("a"));
		a.participate();
		const gate = fake.holdNextExchange();
		const pending = a.reconcile(fake.exchange);
		await gate.received;
		gate.commit();
		await gate.committed;
		const unused = host.open(() => {
			throw new Error("unused");
		});
		unused.retire("quit");
		gate.respond();
		expect(await pending).toBe("applied");
		expect(a.capture().instanceId).toBe(a.inspect().instanceId);
	});
	it("fails closed when the actual manager binding changes while a reply waits", async () => {
		const fixture = savedFixture();
		try {
			const host = new RuntimeHost();
			const fake = new FakeRuntimeCoordinator();
			const a = host.open(() => ({
				piSessionId: fixture.manager.getSessionId(),
				sessionFile: fixture.manager.persistNow(),
			}));
			a.participate();
			const gate = fake.holdNextExchange();
			const waiting = a.reconcile(fake.exchange);
			await gate.received;
			gate.commit();
			await gate.committed;
			fixture.manager.newSession();
			gate.respond();
			expect(await waiting).toBe("superseded");
			expect(a.inspect().state).toBe("retired");
			expect(host.getDesiredImage().runtimes).toHaveLength(0);
		} finally {
			fixture.cleanup();
		}
	});
	it("allows unregistered host flush without resolving its manager", async () => {
		const host = new RuntimeHost();
		const fake = new FakeRuntimeCoordinator();
		const scope = host.open(() => {
			throw new Error("unexpected resolver");
		});
		expect(await scope.reconcile(fake.exchange)).toBe("applied");
		expect(scope.inspect().state).toBe("unregistered");
		expect(() => scope.capture()).toThrow();
		const participant = host.open(binding("saved"));
		participant.participate();
		await participant.reconcile(fake.exchange);
		const previous = participant.capture();
		participant.retire("quit");
		expect(await participant.reconcile(fake.exchange)).toBe("applied");
		expect(fake.attachmentFor(previous.mailboxId)).toBeUndefined();
		expect(() => participant.capture()).toThrow(/retired/);
	});
});
