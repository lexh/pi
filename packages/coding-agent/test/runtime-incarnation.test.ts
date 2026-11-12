import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeHost } from "../src/core/runtime-host.ts";
import type { RuntimeIncarnation } from "../src/core/runtime-incarnation.ts";
import {
	createUnavailableRuntimeLifecycle,
	peekConversationBinding,
	resolveConversationBinding,
} from "../src/core/runtime-incarnation.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { savedFixture } from "./helpers/external-events.ts";

function installAttachment(
	host: RuntimeHost,
	scope: RuntimeIncarnation,
	values: { mailboxId: string; generation: number; generationToken: string },
): void {
	const image = host.getDesiredImage();
	const runtime = image.runtimes[0];
	if (!runtime || image.runtimes.length !== 1) throw new Error("Expected one desired runtime");
	host.acceptReceipt(
		image,
		{
			version: 1,
			operationId: image.operationId,
			hostId: image.hostId,
			revision: image.revision,
			results: [{ status: "attached", attachment: { ...runtime, ...values } }],
		},
		{ connectionId: "test-connection", connectionRevision: 0 },
		scope.inspect().instanceId,
	);
}

describe("local runtime incarnation", () => {
	it("retires waits, grants and claims once before returning", () => {
		const f = savedFixture();
		try {
			const host = new RuntimeHost();
			const scope = host.open(() => resolveConversationBinding(f.manager));
			scope.participate();
			installAttachment(host, scope, { mailboxId: "mailbox-a", generation: 1, generationToken: "token-a" });
			const fence = scope.capture();
			const reasons: string[] = [];
			for (const kind of ["wait", "grant", "claim"] as const)
				scope.track(fence, { kind, id: kind, revoke: (reason) => reasons.push(`${kind}:${reason}`) });
			scope.retire("reload");
			scope.retire("quit");
			expect(scope.isCurrent(fence)).toBe(false);
			expect(() => scope.capture()).toThrow(/retired/);
			expect(reasons).toEqual(["wait:runtime-detached", "grant:runtime-detached", "claim:runtime-detached"]);
		} finally {
			f.cleanup();
		}
	});
	it("cancels synchronously, drains once despite errors, and rejects reentrant old fences", () => {
		const f = savedFixture();
		try {
			const host = new RuntimeHost();
			const scope = host.open(() => resolveConversationBinding(f.manager));
			scope.participate();
			installAttachment(host, scope, { mailboxId: "m", generation: 1, generationToken: "secret" });
			const fence = scope.capture();
			const calls: string[] = [];
			const observedEpochs: number[] = [];
			let reentrantRejected = false;
			const remove = scope.track(fence, { kind: "wait", id: "done", revoke: () => calls.push("done") });
			remove();
			scope.track(fence, {
				kind: "wait",
				id: "first",
				revoke: () => {
					calls.push("first");
					observedEpochs.push(scope.inspect().epoch, host.getDesiredImage().runtimes[0].epoch);
					try {
						scope.track(fence, { kind: "claim", id: "late", revoke: () => {} });
					} catch {
						reentrantRejected = true;
					}
					throw new Error("secret");
				},
			});
			scope.track(fence, { kind: "grant", id: "second", revoke: (reason) => calls.push(reason) });
			scope.cancel();
			scope.cancel();
			expect(calls).toEqual(["first", "cancelled"]);
			expect(observedEpochs).toEqual([1, 1]);
			expect(reentrantRejected).toBe(true);
			expect(scope.inspect().epoch).toBe(2);
			expect(scope.isCurrent(fence)).toBe(false);
		} finally {
			f.cleanup();
		}
	});
	it("retains immutable images and validates whole receipts before mutation", () => {
		const f = savedFixture();
		try {
			const host = new RuntimeHost();
			const initial = host.getDesiredImage();
			const scope = host.open(() => resolveConversationBinding(f.manager));
			expect(host.getDesiredImage()).toBe(initial);
			scope.participate();
			const image = host.getDesiredImage();
			scope.participate();
			expect(host.getDesiredImage()).toBe(image);
			expect(Object.isFrozen(image.runtimes[0].conversation)).toBe(true);
			expect(() =>
				host.acceptReceipt(
					image,
					{
						version: 1,
						operationId: image.operationId,
						hostId: image.hostId,
						revision: image.revision,
						results: [],
					},
					{ connectionId: "c", connectionRevision: 0 },
					scope.inspect().instanceId,
				),
			).toThrow();
			expect(scope.inspect().state).toBe("pending");
			installAttachment(host, scope, { mailboxId: "m", generation: 1, generationToken: "t" });
			const before = readFileSync(f.manager.getSessionFile()!, "utf8");
			scope.cancel();
			scope.retire("quit");
			expect(readFileSync(f.manager.getSessionFile()!, "utf8")).toBe(before);
		} finally {
			f.cleanup();
		}
	});
	it("validates every disposition before applying any and retries explicit refusal", () => {
		const host = new RuntimeHost();
		const a = host.open(() => ({ piSessionId: "a", sessionFile: "/a" }));
		const b = host.open(() => ({ piSessionId: "b", sessionFile: "/b" }));
		a.participate();
		b.participate();
		const image = host.getDesiredImage();
		const receipt = {
			version: 1 as const,
			operationId: image.operationId,
			hostId: image.hostId,
			revision: image.revision,
			results: [
				{
					status: "attached" as const,
					attachment: { ...image.runtimes[0], mailboxId: "m", generation: 1, generationToken: "t" },
				},
				{ status: "refused" as const, runtime: image.runtimes[1], reason: "pane-busy" as const },
			],
		};
		const verification = { connectionId: "c", connectionRevision: 0 };
		expect(() =>
			host.acceptReceipt(
				image,
				{ ...receipt, results: [receipt.results[0], receipt.results[0]] },
				verification,
				a.inspect().instanceId,
			),
		).toThrow();
		expect(a.inspect().state).toBe("pending");
		expect(host.acceptReceipt(image, receipt, verification, b.inspect().instanceId)).toBe("refused");
		expect(host.acceptReceipt(image, receipt, verification, a.inspect().instanceId)).toBe("applied");
		expect(a.capture().mailboxId).toBe("m");
		expect(b.inspect().refusalReason).toBe("pane-busy");
		expect(b.refusedByOperationId).toBe(image.operationId);
		expect(host.getDesiredImage().runtimes).toHaveLength(1);
		b.participate();
		expect(host.getDesiredImage().runtimes).toHaveLength(2);
	});
	it("retains reentrant participation after refusal removes the old desired entry", () => {
		const host = new RuntimeHost();
		const scope = host.open(() => ({ piSessionId: "a", sessionFile: "/a" }));
		scope.participate();
		installAttachment(host, scope, { mailboxId: "m", generation: 1, generationToken: "t" });
		const fence = scope.capture();
		const image = host.getDesiredImage();
		const seen: number[] = [];
		const current: boolean[] = [];
		scope.track(fence, {
			kind: "grant",
			id: "g",
			revoke: () => {
				current.push(scope.isCurrent(fence));
				seen.push(host.getDesiredImage().runtimes.length);
				scope.participate();
			},
		});
		host.acceptReceipt(
			image,
			{
				version: 1,
				operationId: image.operationId,
				hostId: image.hostId,
				revision: image.revision,
				results: [{ status: "refused", runtime: image.runtimes[0], reason: "mailbox-busy" }],
			},
			{ connectionId: "c", connectionRevision: 0 },
			scope.inspect().instanceId,
		);
		expect(seen).toEqual([0]);
		expect(current).toEqual([false]);
		expect(scope.inspect().state).toBe("pending");
		expect(host.getDesiredImage().runtimes).toHaveLength(1);
	});
	it("provides unavailable inspection without inventing an identity", async () => {
		const facade = createUnavailableRuntimeLifecycle("disabled");
		expect(facade.inspect()).toEqual({ state: "unavailable", reason: "disabled" });
		expect(() => facade.participate()).toThrow("disabled");
		await expect(
			facade.reconcile(async () => {
				throw new Error("unused");
			}),
		).rejects.toThrow("disabled");
		facade.cancel();
		facade.disconnect();
	});
	it("fails closed when epoch or host revision is exhausted", () => {
		for (const counters of [{ epoch: Number.MAX_SAFE_INTEGER }, { revision: Number.MAX_SAFE_INTEGER - 1 }]) {
			const f = savedFixture();
			try {
				const host = new RuntimeHost({ initialCounters: counters });
				const scope = host.open(() => resolveConversationBinding(f.manager));
				scope.participate();
				installAttachment(host, scope, { mailboxId: "m", generation: 1, generationToken: "t" });
				const fence = scope.capture();
				const reasons: string[] = [];
				scope.track(fence, { kind: "wait", id: "w", revoke: (reason) => reasons.push(reason) });
				expect(() => scope.cancel()).toThrow(/exhausted/);
				expect(scope.isCurrent(fence)).toBe(false);
				expect(scope.inspect().state).toBe("retired");
				expect(reasons).toEqual(["runtime-detached"]);
				scope.retire("quit");
			} finally {
				f.cleanup();
			}
		}
	});
	it("isolates epoch exhaustion but drains all scopes on host revision exhaustion", () => {
		for (const revisionExhaustion of [false, true]) {
			const host = new RuntimeHost({
				initialCounters: revisionExhaustion
					? { revision: Number.MAX_SAFE_INTEGER - 2 }
					: { epoch: Number.MAX_SAFE_INTEGER },
			});
			const a = host.open(() => ({ piSessionId: "a", sessionFile: "/a" }));
			const b = host.open(() => ({ piSessionId: "b", sessionFile: "/b" }));
			a.participate();
			b.participate();
			const image = host.getDesiredImage();
			const receipt = {
				version: 1 as const,
				operationId: image.operationId,
				hostId: image.hostId,
				revision: image.revision,
				results: image.runtimes.map((runtime) => ({
					status: "attached" as const,
					attachment: { ...runtime, mailboxId: runtime.instanceId, generation: 1, generationToken: "token" },
				})),
			};
			for (const scope of [a, b])
				host.acceptReceipt(
					image,
					receipt,
					{ connectionId: "c", connectionRevision: 0 },
					scope.inspect().instanceId,
				);
			const aFence = a.capture();
			const bFence = b.capture();
			const drained: string[] = [];
			a.track(aFence, { kind: "wait", id: "a", revoke: () => drained.push("a") });
			b.track(bFence, { kind: "claim", id: "b", revoke: () => drained.push("b") });
			expect(() => a.cancel()).toThrow(/exhausted/);
			expect(a.isCurrent(aFence)).toBe(false);
			if (revisionExhaustion) {
				expect(b.isCurrent(bFence)).toBe(false);
				expect(drained.sort()).toEqual(["a", "b"]);
				expect(() => host.open(() => ({ piSessionId: "c", sessionFile: "/c" }))).toThrow(/unavailable/);
			} else {
				expect(b.isCurrent(bFence)).toBe(true);
				expect(drained).toEqual(["a"]);
				expect(host.getDesiredImage().runtimes.map((runtime) => runtime.instanceId)).toEqual([
					b.inspect().instanceId,
				]);
				b.retire("quit");
			}
			a.retire("quit");
			b.retire("quit");
			expect(drained.sort()).toEqual(["a", "b"]);
		}
	});
	it("rejects changed bindings and panes instead of silently rebinding", () => {
		let binding = { piSessionId: "a", sessionFile: "/a" };
		const host = new RuntimeHost();
		const scope = host.open(() => binding);
		scope.participate({ paneId: "pane" });
		expect(() => scope.participate({ paneId: "other" })).toThrow(/pane/);
		binding = { piSessionId: "b", sessionFile: "/b" };
		expect(() => scope.capture()).toThrow(/changed/);
		expect(host.getDesiredImage().runtimes).toHaveLength(0);
	});
	it("persists only when participation is requested", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-runtime-scope-"));
		try {
			const manager = SessionManager.create(directory, directory);
			const host = new RuntimeHost();
			const scope = host.open(() => resolveConversationBinding(manager));
			const path = manager.getSessionFile()!;
			expect(existsSync(path)).toBe(false);
			scope.participate();
			expect(existsSync(path)).toBe(true);
			manager.appendCustomEntry("runtime-test", { value: 1 });
			expect(readFileSync(path, "utf8")).toContain("runtime-test");
			scope.retire("quit");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("refuses ephemeral binding", () => {
		expect(() => resolveConversationBinding(SessionManager.inMemory())).toThrow(/--no-session/);
	});
	it("peeks the binding a saved session resolves to without saving it", () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-runtime-peek-"));
		const alias = `${directory}-alias`;
		try {
			symlinkSync(directory, alias);
			const manager = SessionManager.create(alias, alias);
			const path = manager.getSessionFile()!;
			// Nothing is saved yet: there is no file to resolve, and looking does not save one.
			expect(peekConversationBinding(manager)).toBeUndefined();
			expect(existsSync(path)).toBe(false);
			manager.persistNow();
			const peeked = peekConversationBinding(manager);
			expect(peeked).toEqual(resolveConversationBinding(manager));
			// The session file is resolved through the alias, as the lifecycle's own binding is.
			expect(peeked?.sessionFile).toBe(realpathSync(path));
			expect(peeked?.sessionFile).not.toBe(path);
		} finally {
			rmSync(alias, { force: true });
			rmSync(directory, { recursive: true, force: true });
		}
	});
	it("peeks nothing for an in-memory session", () => {
		expect(peekConversationBinding(SessionManager.inMemory())).toBeUndefined();
	});
});
