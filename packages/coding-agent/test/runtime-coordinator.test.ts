import { describe, expect, it } from "vitest";
import type { DesiredRuntime, HostRuntimeImage, RuntimeFence } from "../src/core/runtime-lifecycle-types.ts";
import { FakeRuntimeCoordinator } from "./helpers/fake-runtime-coordinator.ts";

const auth = { credential: "test-secret" };
const runtime = (
	instanceId: string,
	incarnation: number,
	piSessionId = "session",
	sessionFile = "/session",
	paneId?: string,
): DesiredRuntime => ({
	instanceId,
	incarnation,
	epoch: 0,
	conversation: { piSessionId, sessionFile },
	...(paneId ? { paneId } : {}),
});
const image = (
	revision: number,
	runtimes: DesiredRuntime[],
	hostId = "host",
	maxIncarnation = 10,
): HostRuntimeImage => ({
	version: 1,
	operationId: `${hostId}-${revision}`,
	hostId,
	process: { pid: 42, birthNonce: `${hostId}-birth` },
	revision,
	maxIncarnation,
	runtimes,
});
function fence(
	hostId: string,
	attachment: Awaited<ReturnType<FakeRuntimeCoordinator["exchange"]>>["results"][number],
): RuntimeFence {
	if (attachment.status !== "attached") throw new Error("expected attached");
	return { hostId, ...attachment.attachment, connectionId: "test", connectionRevision: 0, verificationRevision: 0 };
}

describe("fake runtime coordinator", () => {
	it("authenticates and validates before mutation, including unknown registration", async () => {
		const fake = new FakeRuntimeCoordinator();
		const a = image(1, [runtime("a", 1)]);
		await expect(fake.exchange({ ...a, maxIncarnation: 0 }, auth)).rejects.toThrow();
		const accepted = await fake.exchange(a, { credential: "other" });
		expect(accepted.results[0].status).toBe("attached");
		await expect(fake.exchange(image(2, []), auth)).rejects.toThrow();
		expect(fake.attachmentFor(fence("host", accepted.results[0]).mailboxId)?.instanceId).toBe("a");
	});
	it("returns stable retries and fences stale images and operations", async () => {
		const fake = new FakeRuntimeCoordinator();
		const a = image(1, [runtime("a", 1)]);
		const first = await fake.exchange(a, auth);
		const old = fence("host", first.results[0]);
		expect(await fake.exchange(a, auth)).toEqual(first);
		fake.operate(old, "wait", "wait");
		fake.watchExit(old, "exit");
		fake.seedOwnedWork(old.mailboxId, "work");
		const b = image(2, [runtime("b", 2)]);
		const second = await fake.exchange(b, auth);
		const current = fence("host", second.results[0]);
		expect(current.mailboxId).toBe(old.mailboxId);
		expect(current.generation).toBeGreaterThan(old.generation);
		expect(fake.exitResult("exit")).toEqual({ reason: "runtime-detached" });
		expect(fake.resourceState("wait")).toBe("interrupted");
		expect(fake.ownerOf("work")).toBe(old.mailboxId);
		expect(() => fake.operate(old, "old", "status")).toThrow(/stale/);
		await expect(fake.exchange({ ...a, operationId: "old-unseen" }, auth)).rejects.toThrow();
		await expect(fake.exchange({ ...b, runtimes: [] }, auth)).rejects.toThrow();
	});
	it("detaches an unrelated outgoing instance despite a busy target", async () => {
		const fake = new FakeRuntimeCoordinator();
		const a = await fake.exchange(image(1, [runtime("a", 1, "a", "/a")]), auth);
		const old = fence("host", a.results[0]);
		const other = await fake.exchange(image(1, [runtime("other", 1, "b", "/b")], "other"), { credential: "other" });
		const out = await fake.exchange(image(2, [runtime("b", 2, "b", "/b")]), auth);
		expect(out.results[0]).toMatchObject({ status: "refused", reason: "mailbox-busy" });
		expect(fake.attachmentFor(old.mailboxId)).toBeUndefined();
		expect(fake.attachmentFor(fence("other", other.results[0]).mailboxId)?.instanceId).toBe("other");
	});
	it("resolves duplicate proposals in favor of a current attachment or refuses both", async () => {
		const fake = new FakeRuntimeCoordinator();
		const initial = await fake.exchange(image(1, [runtime("a", 1)]), auth);
		const duplicate = await fake.exchange(image(2, [runtime("a", 1), runtime("b", 2)]), auth);
		expect(duplicate.results.map((r) => r.status)).toEqual(["attached", "refused"]);
		expect(fence("host", duplicate.results[0]).generation).toBe(fence("host", initial.results[0]).generation);
		const other = new FakeRuntimeCoordinator();
		const both = await other.exchange(image(1, [runtime("a", 1), runtime("b", 2)]), auth);
		expect(both.results.map((r) => r.status)).toEqual(["refused", "refused"]);
	});
	it("allows a delayed low incarnation and releases only on exact host loss", async () => {
		const fake = new FakeRuntimeCoordinator();
		await fake.exchange(image(1, [], "host", 10), auth);
		const result = await fake.exchange(image(2, [runtime("a", 2)], "host", 10), auth);
		const old = fence("host", result.results[0]);
		fake.seedOwnedWork(old.mailboxId, "work");
		fake.watchExit(old, "exit");
		expect(() => fake.confirmHostLoss("host", { pid: 42, birthNonce: "wrong" })).toThrow();
		fake.confirmHostLoss("host", { pid: 42, birthNonce: "host-birth" });
		expect(fake.exitResult("exit")).toEqual({ reason: "host-lost" });
		expect(fake.ownerOf("work")).toBe(old.mailboxId);
		await expect(fake.exchange(image(3, []), auth)).rejects.toThrow();
		const successor = await fake.exchange(image(1, [runtime("next", 1)], "next"), { credential: "next" });
		expect(fence("next", successor.results[0]).mailboxId).toBe(old.mailboxId);
	});
	it("revokes prior epoch resources without treating cancellation as exit", async () => {
		const fake = new FakeRuntimeCoordinator();
		const first = await fake.exchange(image(1, [runtime("a", 1)]), auth);
		const old = fence("host", first.results[0]);
		for (const kind of ["wait", "grant", "claim"] as const) fake.operate(old, kind, kind);
		fake.watchExit(old, "exit");
		const next = await fake.exchange(image(2, [{ ...runtime("a", 1), epoch: 1 }]), auth);
		expect(fake.resourceState("wait")).toBe("interrupted");
		expect(fake.resourceState("grant")).toBe("revoked");
		expect(fake.resourceState("claim")).toBe("retired");
		expect(fake.exitResult("exit")).toBeUndefined();
		expect(() => fake.operate(old, "status", "status")).toThrow(/stale/);
		expect(fence("host", next.results[0]).generation).toBe(old.generation);
	});
	it("refuses header conflicts and live panes without mutating other attachments", async () => {
		const fake = new FakeRuntimeCoordinator();
		const first = await fake.exchange(image(1, [runtime("a", 1, "s", "/a", "pane")]), auth);
		const old = fence("host", first.results[0]);
		const otherAuth = { credential: "other" };
		const conflict = await fake.exchange(image(1, [runtime("b", 1, "s", "/b")], "other"), otherAuth);
		expect(conflict.results[0]).toMatchObject({ status: "refused", reason: "identity-conflict" });
		const pane = await fake.exchange(image(2, [runtime("c", 2, "different", "/c", "pane")], "other"), otherAuth);
		expect(pane.results[0]).toMatchObject({ status: "refused", reason: "pane-busy" });
		expect(fake.attachmentFor(old.mailboxId)?.instanceId).toBe("a");
	});
	it("rejects changed identity and detached instance reuse", async () => {
		const fake = new FakeRuntimeCoordinator();
		const first = await fake.exchange(image(1, [runtime("a", 1)]), auth);
		const old = fence("host", first.results[0]);
		await expect(fake.exchange(image(2, [runtime("a", 1, "s", "/other")]), auth)).rejects.toThrow();
		expect(fake.attachmentFor(old.mailboxId)?.instanceId).toBe("a");
		await fake.exchange(image(2, []), auth);
		await expect(fake.exchange(image(3, [runtime("a", 1)]), auth)).rejects.toThrow();
		await expect(fake.exchange(image(3, [runtime("b", 1)]), auth)).rejects.toThrow();
	});
	it("allows a refused never-attached scope to retry after the target is released", async () => {
		const fake = new FakeRuntimeCoordinator();
		await fake.exchange(image(1, [runtime("a", 1)]), auth);
		const other = { credential: "other" };
		const refused = await fake.exchange(image(1, [runtime("b", 1)], "other"), other);
		expect(refused.results[0].status).toBe("refused");
		await fake.exchange(image(2, []), auth);
		const retried = await fake.exchange(image(2, [runtime("b", 1)], "other"), other);
		expect(retried.results[0].status).toBe("attached");
	});
	it("rejects a held older commit after a newer image commits", async () => {
		const fake = new FakeRuntimeCoordinator();
		const gate = fake.holdNextExchange();
		const old = fake.exchange(image(1, [runtime("a", 1)]), auth);
		const oldResult = expect(old).rejects.toThrow(/Stale/);
		await gate.received;
		await fake.exchange(image(2, [runtime("b", 2)]), auth);
		gate.commit();
		await expect(gate.committed).rejects.toThrow(/Stale/);
		await oldResult;
	});
	it("holds commit and response independently", async () => {
		const fake = new FakeRuntimeCoordinator();
		const gate = fake.holdNextExchange();
		const request = fake.exchange(image(1, [runtime("a", 1)]), auth);
		await gate.received;
		fake.disconnect();
		gate.commit();
		await gate.committed;
		gate.respond();
		expect((await request).results[0].status).toBe("attached");
		await expect(fake.exchange(image(2, []), auth)).rejects.toThrow();
	});
});
