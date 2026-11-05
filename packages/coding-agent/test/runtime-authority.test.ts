import { copyFileSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeHost } from "../src/core/runtime-host.ts";
import { resolveConversationBinding } from "../src/core/runtime-incarnation.ts";
import type { HostRuntimeImage, RuntimeExchange } from "../src/core/runtime-lifecycle-types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { canonical, savedFixture } from "./helpers/external-events.ts";
import { FakeRuntimeCoordinator } from "./helpers/fake-runtime-coordinator.ts";

describe("runtime authority", () => {
	it.each(["wait", "grant", "claim", "status"] as const)(
		"rejects raw stale %s after authenticated handover",
		async (kind) => {
			const fixture = savedFixture();
			const fake = new FakeRuntimeCoordinator();
			const host = new RuntimeHost();
			const resolve = () => resolveConversationBinding(fixture.manager);
			const a = host.open(resolve);
			try {
				a.participate();
				await a.reconcile(fake.exchange);
				const old = a.capture();
				for (const resource of ["wait", "grant", "claim"] as const) fake.operate(old, `a-${resource}`, resource);
				a.retire("reload");
				const b = host.open(resolve);
				b.participate();
				await b.reconcile(fake.exchange);
				const current = b.capture();
				expect(current.mailboxId).toBe(old.mailboxId);
				expect(current.generation).toBeGreaterThan(old.generation);
				expect(() => fake.operate(old, `stale-${kind}`, kind)).toThrow(/stale/);
				expect(fake.hasOperation(`stale-${kind}`)).toBe(false);
				expect(fake.resourceState(`stale-${kind}`)).toBeUndefined();
				expect([
					fake.resourceState("a-wait"),
					fake.resourceState("a-grant"),
					fake.resourceState("a-claim"),
				]).toEqual(["interrupted", "revoked", "retired"]);
				expect(fake.attachmentFor(current.mailboxId)?.instanceId).toBe(current.instanceId);
				expect(fake.activeResourcesFor(current)).toEqual([]);
				expect(b.isCurrent(current)).toBe(true);
				b.retire("quit");
			} finally {
				fixture.cleanup();
			}
		},
	);

	it("refuses competing hosts, reused process identity, pane and same-host scopes", async () => {
		const f = savedFixture();
		const other = savedFixture();
		const fake = new FakeRuntimeCoordinator();
		const host = new RuntimeHost({ process: { pid: 42, birthNonce: "first" } });
		const resolve = () => resolveConversationBinding(f.manager);
		try {
			const a = host.open(resolve);
			a.participate({ paneId: "pane" });
			await a.reconcile(fake.exchange);
			const fence = a.capture();
			fake.setHeartbeatPresent(fence.hostId, true);
			expect(fake.heartbeatPresent(fence.hostId)).toBe(true);
			fake.setHeartbeatPresent(fence.hostId, false);
			expect(fake.heartbeatPresent(fence.hostId)).toBe(false);
			for (const process of [
				{ pid: 43, birthNonce: "other" },
				{ pid: 42, birthNonce: "reused" },
			]) {
				const rival = new RuntimeHost({ process }).open(resolve);
				rival.participate();
				expect(await rival.reconcile(fake.exchange)).toBe("refused");
				expect(rival.inspect().refusalReason).toBe("mailbox-busy");
				expect(fake.heartbeatPresent(fence.hostId)).toBe(false);
				expect(fake.attachmentFor(fence.mailboxId)?.instanceId).toBe(fence.instanceId);
			}
			const pane = new RuntimeHost().open(() => resolveConversationBinding(other.manager));
			pane.participate({ paneId: "pane" });
			expect(await pane.reconcile(fake.exchange)).toBe("refused");
			expect(pane.inspect().refusalReason).toBe("pane-busy");
			const sameHost = host.open(resolve);
			sameHost.participate();
			expect(await sameHost.reconcile(fake.exchange)).toBe("refused");
			expect(sameHost.inspect().refusalReason).toBe("mailbox-busy");
			expect(host.getDesiredImage().runtimes.map((entry) => entry.instanceId)).toEqual([fence.instanceId]);
			expect(a.isCurrent(fence)).toBe(true);
		} finally {
			f.cleanup();
			other.cleanup();
		}
	});

	it("canonicalizes real symlinks and refuses conflicting header/file identities", async () => {
		const f = savedFixture();
		const other = savedFixture();
		const fake = new FakeRuntimeCoordinator();
		try {
			const source = resolveConversationBinding(f.manager);
			const alias = join(f.directory, "alias.jsonl");
			symlinkSync(source.sessionFile, alias);
			const aliasManager = SessionManager.open(alias, f.directory);
			expect(resolveConversationBinding(aliasManager)).toEqual(source);
			const a = new RuntimeHost().open(() => resolveConversationBinding(f.manager));
			a.participate();
			await a.reconcile(fake.exchange);
			const old = a.capture();
			const contender = new RuntimeHost().open(() => resolveConversationBinding(aliasManager));
			contender.participate();
			expect(await contender.reconcile(fake.exchange)).toBe("refused");
			expect(contender.inspect().refusalReason).toBe("mailbox-busy");
			const otherBinding = resolveConversationBinding(other.manager);
			const copiedFile = join(other.directory, "same-header.jsonl");
			copyFileSync(source.sessionFile, copiedFile);
			const copied = resolveConversationBinding(SessionManager.open(copiedFile, other.directory));
			expect(copied.piSessionId).toBe(source.piSessionId);
			expect(copied.sessionFile).not.toBe(source.sessionFile);
			for (const conflict of [copied, { ...source, piSessionId: otherBinding.piSessionId }]) {
				const scope = new RuntimeHost().open(() => conflict);
				scope.participate();
				expect(await scope.reconcile(fake.exchange)).toBe("refused");
				expect(scope.inspect().refusalReason).toBe("identity-conflict");
			}
			expect(fake.attachmentFor(old.mailboxId)?.instanceId).toBe(old.instanceId);
		} finally {
			f.cleanup();
			other.cleanup();
		}
	});

	it("detaches X despite busy Y and removes the refused desired intent", async () => {
		const x = savedFixture();
		const y = savedFixture();
		const z = savedFixture();
		const fake = new FakeRuntimeCoordinator();
		const owner = new RuntimeHost();
		const rival = new RuntimeHost();
		try {
			const occupied = rival.open(() => resolveConversationBinding(y.manager));
			occupied.participate();
			await occupied.reconcile(fake.exchange);
			const occupiedFence = occupied.capture();
			const outgoing = owner.open(() => resolveConversationBinding(x.manager));
			outgoing.participate();
			await outgoing.reconcile(fake.exchange);
			const old = outgoing.capture();
			fake.watchExit(old, "x-exit");
			outgoing.retire("resume");
			const busy = owner.open(() => resolveConversationBinding(y.manager));
			busy.participate();
			expect(await busy.reconcile(fake.exchange)).toBe("refused");
			expect(fake.attachmentFor(old.mailboxId)).toBeUndefined();
			expect(fake.exitResult("x-exit")).toEqual({ reason: "runtime-detached" });
			expect(fake.attachmentFor(occupiedFence.mailboxId)?.instanceId).toBe(occupiedFence.instanceId);
			expect(owner.getDesiredImage().runtimes).toEqual([]);
			const independent = owner.open(() => resolveConversationBinding(z.manager));
			independent.participate();
			expect(await independent.reconcile(fake.exchange)).toBe("applied");
			expect(independent.capture().mailboxId).not.toBe(occupiedFence.mailboxId);
		} finally {
			x.cleanup();
			y.cleanup();
			z.cleanup();
		}
	});

	it("fences a predecessor even when its successor has an invalid binding", async () => {
		const x = savedFixture();
		const y = savedFixture();
		const fake = new FakeRuntimeCoordinator();
		const host = new RuntimeHost();
		try {
			const a = host.open(() => resolveConversationBinding(x.manager));
			a.participate();
			await a.reconcile(fake.exchange);
			const old = a.capture();
			fake.watchExit(old, "exit");
			const other = new RuntimeHost().open(() => resolveConversationBinding(y.manager));
			other.participate();
			await other.reconcile(fake.exchange);
			const invalid = { ...resolveConversationBinding(y.manager), piSessionId: x.manager.getSessionId() };
			a.retire("new");
			const b = host.open(() => invalid);
			b.participate();
			expect(await b.reconcile(fake.exchange)).toBe("refused");
			expect(b.inspect().refusalReason).toBe("identity-conflict");
			expect(fake.attachmentFor(old.mailboxId)).toBeUndefined();
			expect(fake.exitResult("exit")).toEqual({ reason: "runtime-detached" });
			expect(() => fake.operate(old, "late", "status")).toThrow(/stale/);
			expect(host.getDesiredImage().runtimes).toEqual([]);
		} finally {
			x.cleanup();
			y.cleanup();
		}
	});

	it("requires exact host-loss evidence and rejects revoked images and tokens", async () => {
		const f = savedFixture();
		const fake = new FakeRuntimeCoordinator();
		const process = { pid: 44, birthNonce: "birth" };
		const host = new RuntimeHost({ process });
		let captured: { image: HostRuntimeImage; credential: string } | undefined;
		const exchange: RuntimeExchange = async (image, auth) => {
			captured = { image: structuredClone(image), credential: auth.credential };
			return fake.exchange(image, auth);
		};
		try {
			f.manager.appendEntryOnce(canonical("pending"), f.selected);
			const bytes = readFileSync(f.manager.getSessionFile()!);
			const a = host.open(() => resolveConversationBinding(f.manager));
			a.participate();
			await a.reconcile(exchange);
			const old = a.capture();
			for (const kind of ["wait", "grant", "claim"] as const) fake.operate(old, kind, kind);
			fake.seedOwnedWork(old.mailboxId, "work");
			fake.watchExit(old, "watch");
			expect(() => fake.confirmHostLoss("unknown", process)).toThrow();
			expect(() => fake.confirmHostLoss(old.hostId, { ...process, pid: process.pid + 1 })).toThrow();
			expect(() => fake.confirmHostLoss(old.hostId, { ...process, birthNonce: "wrong" })).toThrow();
			expect(fake.attachmentFor(old.mailboxId)?.instanceId).toBe(old.instanceId);
			expect(fake.resourceState("wait")).toBe("active");
			expect(fake.exitResult("watch")).toBeUndefined();
			fake.confirmHostLoss(old.hostId, process);
			expect(fake.exitResult("watch")).toEqual({ reason: "host-lost" });
			expect(() => fake.confirmHostLoss(old.hostId, process)).toThrow();
			expect(fake.exitResult("watch")).toEqual({ reason: "host-lost" });
			expect([fake.resourceState("wait"), fake.resourceState("grant"), fake.resourceState("claim")]).toEqual([
				"interrupted",
				"revoked",
				"retired",
			]);
			const next = new RuntimeHost().open(() => resolveConversationBinding(f.manager));
			next.participate();
			await next.reconcile(fake.exchange);
			const current = next.capture();
			expect(current.mailboxId).toBe(old.mailboxId);
			expect(current.generation).toBeGreaterThan(old.generation);
			expect(fake.ownerOf("work")).toBe(old.mailboxId);
			expect(readFileSync(f.manager.getSessionFile()!)).toEqual(bytes);
			await expect(fake.exchange(captured!.image, { credential: captured!.credential })).rejects.toThrow(
				/authentication/i,
			);
			await expect(
				fake.exchange(
					{ ...captured!.image, operationId: "new-image", revision: captured!.image.revision + 1 },
					{ credential: captured!.credential },
				),
			).rejects.toThrow(/authentication/i);
			await expect(
				fake.exchange(
					{ ...captured!.image, operationId: "fresh-credential", revision: captured!.image.revision + 2 },
					{ credential: "new-credential" },
				),
			).rejects.toThrow(/authentication/i);
			expect(() => fake.operate(old, "old", "status")).toThrow(/stale/);
		} finally {
			f.cleanup();
		}
	});

	it("host loss after an offline replacement releases only the known predecessor", async () => {
		const f = savedFixture();
		const fake = new FakeRuntimeCoordinator();
		const process = { pid: 45, birthNonce: "birth" };
		const host = new RuntimeHost({ process });
		let captured: { image: HostRuntimeImage; credential: string } | undefined;
		const exchange: RuntimeExchange = async (image, auth) => {
			captured = { image: structuredClone(image), credential: auth.credential };
			return fake.exchange(image, auth);
		};
		try {
			f.manager.appendEntryOnce(canonical("pending"), f.selected);
			const bytes = readFileSync(f.manager.getSessionFile()!);
			const resolve = () => resolveConversationBinding(f.manager);
			const a = host.open(resolve);
			a.participate();
			await a.reconcile(exchange);
			const old = a.capture();
			fake.watchExit(old, "exit");
			fake.seedOwnedWork(old.mailboxId, "work");
			for (const kind of ["wait", "grant", "claim"] as const) fake.operate(old, `offline-${kind}`, kind);
			fake.disconnect();
			a.retire("reload");
			const b = host.open(resolve);
			b.participate();
			const pending = host.getDesiredImage();
			await expect(b.reconcile(fake.exchange)).rejects.toThrow("Coordinator disconnected");
			expect(() => b.capture()).toThrow();
			expect(fake.attachmentFor(old.mailboxId)?.instanceId).toBe(old.instanceId);
			fake.confirmHostLoss(old.hostId, process);
			expect(fake.exitResult("exit")).toEqual({ reason: "host-lost" });
			expect([
				fake.resourceState("offline-wait"),
				fake.resourceState("offline-grant"),
				fake.resourceState("offline-claim"),
			]).toEqual(["interrupted", "revoked", "retired"]);
			fake.reconnect();
			await expect(fake.exchange(pending, { credential: captured!.credential })).rejects.toThrow(/authentication/i);
			const next = new RuntimeHost().open(resolve);
			next.participate();
			await next.reconcile(fake.exchange);
			expect(next.capture().mailboxId).toBe(old.mailboxId);
			expect(next.capture().instanceId).not.toBe(b.inspect().instanceId);
			expect(fake.ownerOf("work")).toBe(old.mailboxId);
			expect(readFileSync(f.manager.getSessionFile()!)).toEqual(bytes);
			expect(() => fake.operate(old, "stale", "status")).toThrow(/stale/);
		} finally {
			f.cleanup();
		}
	});

	it.each(["before", "after"] as const)("orders an old operation committed %s handover", async (order) => {
		const f = savedFixture();
		const fake = new FakeRuntimeCoordinator();
		const host = new RuntimeHost();
		try {
			const resolve = () => resolveConversationBinding(f.manager);
			const a = host.open(resolve);
			a.participate();
			await a.reconcile(fake.exchange);
			const fence = a.capture();
			const gate = fake.holdOperation(fence, "ordered", "claim");
			let continuations = 0;
			const delivery = gate.response.then(() => {
				if (a.isCurrent(fence)) continuations++;
			});
			const rejectedDelivery = order === "after" ? expect(delivery).rejects.toThrow(/stale/) : undefined;
			const rejectedCommit = order === "after" ? expect(gate.committed).rejects.toThrow(/stale/) : undefined;
			const rejectedResponse = order === "after" ? expect(gate.response).rejects.toThrow(/stale/) : undefined;
			await gate.received;
			if (order === "before") {
				gate.commit();
				await gate.committed;
			}
			a.retire("reload");
			const b = host.open(resolve);
			b.participate();
			await b.reconcile(fake.exchange);
			fake.operate(b.capture(), "successor-status", "status");
			if (order === "before") {
				gate.respond();
				await delivery;
				expect(fake.hasOperation("ordered")).toBe(true);
				expect(fake.resourceState("ordered")).toBe("retired");
			} else {
				gate.commit();
				await rejectedCommit;
				await rejectedResponse;
				await rejectedDelivery;
				expect(fake.hasOperation("ordered")).toBe(false);
				expect(fake.resourceState("ordered")).toBeUndefined();
			}
			expect(continuations).toBe(0);
		} finally {
			f.cleanup();
		}
	});

	it("retains a winning wait match while suppressing its late local continuation", async () => {
		const f = savedFixture();
		const fake = new FakeRuntimeCoordinator();
		const host = new RuntimeHost();
		try {
			const resolve = () => resolveConversationBinding(f.manager);
			const a = host.open(resolve);
			a.participate();
			await a.reconcile(fake.exchange);
			const fence = a.capture();
			let interruptions = 0;
			let continuations = 0;
			a.track(fence, { kind: "wait", id: "local", revoke: () => interruptions++ });
			const gate = fake.holdOperation(fence, "wait", "wait");
			const delivery = gate.response.then(() => {
				if (a.isCurrent(fence)) continuations++;
			});
			await gate.received;
			gate.commit();
			await gate.committed;
			fake.seedWaitMatch(fence, "wait", "matched-event");
			a.retire("reload");
			const b = host.open(resolve);
			b.participate();
			await b.reconcile(fake.exchange);
			gate.respond();
			await delivery;
			expect(fake.waitMatch("wait")).toBe("matched-event");
			expect(fake.resourceState("wait")).toBe("interrupted");
			expect(interruptions).toBe(1);
			expect(continuations).toBe(0);
		} finally {
			f.cleanup();
		}
	});
});
