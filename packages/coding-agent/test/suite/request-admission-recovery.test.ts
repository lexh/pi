import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { recordKey } from "../../src/core/durable-records.ts";
import { resolveConversationBinding } from "../../src/core/runtime-incarnation.ts";
import type { HostRuntimeImage, RuntimeExchange } from "../../src/core/runtime-lifecycle-types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { savedFixture } from "../helpers/external-events.ts";
import { FakeRequestCoordinator, type RequestRecoveryImage } from "../helpers/fake-request-coordinator.ts";
import { FakeRuntimeCoordinator } from "../helpers/fake-runtime-coordinator.ts";
import { createAdmissionHarness } from "../helpers/request-admission.ts";
import { userMsg } from "../utilities.ts";
import { createHarness } from "./harness.ts";

describe("real admission crash recovery", () => {
	it.each(["canonical", "commit", "prefix", "batch", "stream"] as const)(
		"repairs the %s crash without replay",
		async (phase) => {
			const fixture = savedFixture();
			const file = fixture.manager.getSessionFile()!;
			const authority = new FakeRuntimeCoordinator();
			const evidencePath = resolve(fixture.directory, "authority.json");
			const resolver = pathToFileURL(resolve("src/experimental/source-resolver.ts")).href;
			const child = spawn(
				process.execPath,
				["--import", resolver, resolve("test/fixtures/request-admission-crash.ts"), file, phase],
				{
					cwd: process.cwd(),
					env: { ...process.env, PI_OFFLINE: "1" },
					stdio: ["ignore", "pipe", "pipe", "ipc"],
				},
			);
			if (!child.stdout || !child.stderr) throw new Error("Child pipes unavailable");
			let host: HostRuntimeImage | undefined;
			let stderr = "";
			let stdout = "";
			let starts = 0;
			let streams = 0;
			let providers = 0;
			let providerCalls = 0;
			let image: RequestRecoveryImage | undefined;
			let callbackError: unknown;
			const boundary = Promise.withResolvers<void>();
			child.stderr.on("data", (data) => {
				stderr += String(data);
			});
			child.stdout.on("data", (data) => {
				stdout += String(data);
				if (stdout.includes(`${phase.toUpperCase()}\n`)) boundary.resolve();
			});
			child.on(
				"message",
				(message: {
					type: string;
					image?: HostRuntimeImage | RequestRecoveryImage;
					authentication?: Parameters<RuntimeExchange>[1];
					calls?: number;
				}) => {
					void (async () => {
						if (message.type === "exchange") {
							host = message.image as HostRuntimeImage;
							const receipt = await authority.exchange(host, message.authentication!);
							child.send({ type: "exchange", receipt });
						} else if (message.type === "commit" || message.type === "canonical") {
							image = message.image as RequestRecoveryImage;
							writeFileSync(evidencePath, JSON.stringify(image));
							const fd = openSync(evidencePath, "r");
							try {
								fsyncSync(fd);
							} finally {
								closeSync(fd);
							}
							if (message.type === "canonical") boundary.resolve();
							else child.send({ type: "ack" });
						} else if (message.type === "boundary") boundary.resolve();
						else if (message.type === "agent-start") starts++;
						else if (message.type === "stream-invoked") streams++;
						else if (message.type === "provider-invoked") {
							providers++;
							providerCalls = message.calls ?? -1;
							if (phase === "stream") boundary.resolve();
						}
					})().catch((error) => {
						callbackError = error;
						boundary.reject(error);
					});
				},
			);
			const exited = once(child, "exit");
			const timeout = setTimeout(() => boundary.reject(new Error(`Child timed out: ${stderr}`)), 10000);
			let fresh: Awaited<ReturnType<typeof createHarness>> | undefined;
			try {
				await boundary.promise;
				clearTimeout(timeout);
				expect(callbackError).toBeUndefined();
				expect(image).toBeDefined();
				expect(host).toBeDefined();
				child.kill("SIGKILL");
				const [, signal] = await exited;
				expect(signal).toBe("SIGKILL");
				authority.confirmHostLoss(host!.hostId, host!.process);
				const evidence = readFileSync(evidencePath, "utf8");
				expect(evidence).not.toMatch(/"(?:generationToken|connectionId|verificationRevision|authentication)"\s*:/);
				const recoveredImage: RequestRecoveryImage = JSON.parse(evidence);
				const manager = SessionManager.open(file);
				if (phase !== "canonical") {
					const descriptors = recoveredImage.requests[0].result.entries;
					const present = descriptors.filter((entry) => manager.getEntry(entry.entryId) !== undefined).length;
					expect(present).toBe(phase === "commit" ? 0 : phase === "prefix" ? 1 : 2);
					expect(recoveredImage.requests[0].suppressed).toBe(false);
					expect(recoveredImage.consumption.find(([key]) => key.includes("crash-one"))?.[1]).toBeNull();
				}
				const sibling = manager.appendMessage(userMsg("selected sibling"));
				fresh = await createHarness({ sessionManager: manager });
				fresh.session.refreshContext();
				fresh.session.runtimeLifecycle.participate();
				await fresh.session.runtimeLifecycle.reconcile(authority.exchange);
				const coordinator = new FakeRequestCoordinator(
					authority,
					undefined,
					recoveredImage,
					fresh.session.runtimeLifecycle.capture().mailboxId,
				);
				fresh.session.requestAdmission.bind(coordinator);
				const stream = vi.spyOn(fresh.session.agent, "streamFunction");
				expect(fresh.eventsOfType("agent_start")).toHaveLength(0);
				expect(fresh.faux.state.callCount).toBe(0);
				expect(stream).not.toHaveBeenCalled();
				await fresh.session.requestAdmission.reconcile();
				const bytes = readFileSync(file);
				await fresh.session.requestAdmission.reconcile();
				expect(readFileSync(file)).toEqual(bytes);
				expect(manager.getLeafId()).toBe(sibling);
				expect(SessionManager.open(file).getLeafId()).toBe(sibling);
				expect(starts).toBe(1);
				expect(streams).toBe(phase === "stream" ? 1 : 0);
				expect(providers).toBe(phase === "stream" ? 1 : 0);
				expect(providerCalls).toBe(phase === "stream" ? 1 : 0);
				expect(stream).not.toHaveBeenCalled();
				expect(fresh.eventsOfType("agent_start")).toHaveLength(0);
				expect(fresh.faux.state.callCount).toBe(0);
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(stream).not.toHaveBeenCalled();
				expect(fresh.session.messages).toEqual(manager.buildSessionProjection().messages);
				if (phase === "canonical") {
					expect(recoveredImage.requests).toHaveLength(0);
					expect(
						recoveredImage.events.every(
							(event) =>
								event.state === "pending" &&
								event.deliveredAt !== null &&
								event.readAt === null &&
								event.receipt !== null,
						),
					).toBe(true);
					const canonical = recoveredImage.events[0].canonical;
					const originalReceipt = manager.getEntryOnce(recordKey(canonical));
					expect(originalReceipt).toEqual(recoveredImage.events[0].receipt);
					expect(coordinator.inspectConsumption(canonical)).toBe("claim");
					expect(coordinator.inspectEvent(canonical)).toMatchObject({
						state: "pending",
						readAt: null,
						deliveredAt: recoveredImage.events[0].deliveredAt,
						receipt: originalReceipt,
					});
					expect(coordinator.exportRecoveryImage().requests).toHaveLength(0);
					fresh.setResponses([fauxAssistantMessage("explicit redelivery")]);
					await fresh.session.prompt("explicit redelivery request");
					expect(manager.getEntryOnce(recordKey(canonical))).toEqual(originalReceipt);
					expect(coordinator.inspectEvent(canonical)?.state).toBe("read");
					expect(coordinator.inspectConsumption(canonical)).toBeNull();
					const beforeConflict = readFileSync(file);
					expect(() => manager.appendEntryOnce({ ...canonical, envelope: "different content" }, null)).toThrow();
					expect(readFileSync(file)).toEqual(beforeConflict);
					expect(fresh.faux.state.callCount).toBe(1);
				} else {
					expect(recoveredImage.requests).toHaveLength(1);
					for (const entry of recoveredImage.requests[0].result.entries) {
						expect(manager.getEntry(entry.entryId)).toMatchObject({
							parentId: entry.record.branchAnchor,
							timestamp: entry.timestamp,
							data: entry.record,
						});
					}
					expect(recoveredImage.requests[0].result.entries).toHaveLength(2);
					expect(recoveredImage.events.every((event) => event.state === "read")).toBe(true);
				}
			} finally {
				clearTimeout(timeout);
				if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
				await exited.catch(() => {});
				fresh?.cleanup();
				fixture.cleanup();
			}
		},
	);
});

describe("explicit admission recovery", () => {
	it.each(["disconnect", "retire", "rebind", "reload"] as const)(
		"rejects a late recovery response after %s",
		async (action) => {
			const fixture = await createAdmissionHarness();
			try {
				const { harness, coordinator, manager } = fixture;
				const dispose = harness.session.requestAdmission.bind(coordinator);
				const entered = Promise.withResolvers<void>();
				const release = Promise.withResolvers<void>();
				const original = coordinator.recover.bind(coordinator);
				vi.spyOn(coordinator, "recover").mockImplementation(async (...args) => {
					const value = await original(...args);
					entered.resolve();
					await release.promise;
					return value;
				});
				const append = vi.spyOn(manager, "appendAdmissionBatchOnce");
				const refresh = vi.spyOn(harness.session, "refreshExternalEvents");
				const bytes = readFileSync(manager.getSessionFile()!);
				const running = harness.session.requestAdmission.reconcile();
				const rejected = expect(running).rejects.toThrow("stale");
				await entered.promise;
				if (action === "disconnect") harness.session.runtimeLifecycle.disconnect();
				else if (action === "retire") harness.session.retireRuntime("reload");
				else if (action === "reload") await harness.session.reload();
				else {
					dispose();
					harness.session.requestAdmission.bind(coordinator);
				}
				release.resolve();
				await rejected;
				expect(append).not.toHaveBeenCalled();
				expect(refresh).not.toHaveBeenCalled();
				expect(readFileSync(manager.getSessionFile()!)).toEqual(bytes);
				expect(harness.faux.state.callCount).toBe(0);
			} finally {
				fixture.cleanup();
			}
		},
	);

	it("repairs a committed chain at its original anchor without selecting or replaying", async () => {
		const fixture = await createAdmissionHarness();
		const { harness, coordinator, manager, runtimeCoordinator } = fixture;
		let fresh: Awaited<ReturnType<typeof createHarness>> | undefined;
		try {
			harness.session.refreshContext();
			const one = coordinator.seedEvent("recover-one", "RECOVER_ONE");
			const two = coordinator.seedEvent("recover-two", "RECOVER_TWO");
			coordinator.seedMatchingConsumption(one, "claim-one");
			harness.session.requestAdmission.bind(coordinator);
			const held = coordinator.holdNextAdmission();
			const admit = vi.spyOn(coordinator, "admit");
			const running = harness.session.prompt("original request");
			await held.received;
			held.commit();
			await held.committed;
			const requestId = admit.mock.calls[0][0].request.requestId;
			const committed = coordinator.inspectRequest(requestId)!;
			const sibling = manager.appendMessage(userMsg("selected sibling"));
			const file = manager.getSessionFile()!;
			harness.session.retireRuntime("reload");
			held.respond();
			await running;
			expect(coordinator.inspectRequest(requestId)?.suppressed).toBe(true);
			const image = coordinator.exportRecoveryImage();
			expect(image.requests.find((request) => request.result.requestId === requestId)?.suppressed).toBe(true);
			harness.cleanup();
			const reopened = SessionManager.open(file);
			fresh = await createHarness({ sessionManager: reopened });
			fresh.session.refreshContext();
			fresh.session.runtimeLifecycle.participate();
			await fresh.session.runtimeLifecycle.reconcile(runtimeCoordinator.exchange);
			const recovered = new FakeRequestCoordinator(
				runtimeCoordinator,
				undefined,
				image,
				fresh.session.runtimeLifecycle.capture().mailboxId,
			);
			const dispose = fresh.session.requestAdmission.bind(recovered);
			expect(recovered.inspectRequest(requestId)?.suppressed).toBe(true);
			const stream = vi.spyOn(fresh.session.agent, "streamFunction");
			const before = readFileSync(file);
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const originalRecover = recovered.recover.bind(recovered);
			const recovery = vi.spyOn(recovered, "recover").mockImplementationOnce(async (...args) => {
				const result = await originalRecover(...args);
				expect(result.commits[0].entries).toHaveLength(2);
				for (const entry of result.commits[0].entries) expect(reopened.getEntry(entry.entryId)).toBeUndefined();
				entered.resolve();
				await release.promise;
				return result;
			});
			const append = vi.spyOn(reopened, "appendAdmissionBatchOnce");
			const stale = fresh.session.requestAdmission.reconcile();
			const rejected = expect(stale).rejects.toThrow("stale");
			await entered.promise;
			dispose();
			fresh.session.requestAdmission.bind(recovered);
			release.resolve();
			await rejected;
			expect(append).not.toHaveBeenCalled();
			expect(readFileSync(file)).toEqual(before);
			expect(reopened.getLeafId()).toBe(sibling);
			expect(stream).not.toHaveBeenCalled();
			recovery.mockRestore();
			await fresh.session.requestAdmission.reconcile();
			expect(recovered.inspectRequest(requestId)?.suppressed).toBe(true);
			const repaired = readFileSync(file);
			expect(repaired.length).toBeGreaterThan(before.length);
			for (const entry of committed.result.entries) {
				const actual = reopened.getEntry(entry.entryId);
				expect(actual).toMatchObject({
					id: entry.entryId,
					parentId: entry.record.branchAnchor,
					timestamp: entry.timestamp,
					data: entry.record,
				});
			}
			expect(committed.result.entries).toHaveLength(2);
			const cards = fresh.session
				.getExternalEventView(reopened.getEntries())
				.filter((item) => item.type === "external_event");
			expect(cards).toHaveLength(2);
			expect(new Set(cards.map((card) => card.key)).size).toBe(2);
			const originalBranch = reopened.getBranch(committed.result.entries[1].entryId);
			expect(originalBranch.some((entry) => entry.id === committed.result.entries[0].entryId)).toBe(true);
			expect(recovered.inspectEvent(one)?.state).toBe("read");
			expect(recovered.inspectEvent(two)?.state).toBe("read");
			expect(recovered.inspectConsumption(one)).toBeNull();
			expect(recovered.inspectRequest(requestId)?.suppressed).toBe(true);
			await fresh.session.requestAdmission.reconcile();
			expect(recovered.inspectRequest(requestId)?.suppressed).toBe(true);
			expect(readFileSync(file)).toEqual(repaired);
			expect(reopened.getLeafId()).toBe(sibling);
			expect(SessionManager.open(file).getLeafId()).toBe(sibling);
			expect(stream).not.toHaveBeenCalled();
			expect(fresh.faux.state.callCount).toBe(0);
			expect(fresh.eventsOfType("agent_start")).toHaveLength(0);
			const evidence = await recovered.recover(resolveConversationBinding(reopened));
			for (const invalid of [
				"request",
				"mailbox",
				"anchor",
				"provenance",
				"view",
				"body",
				"entry-id",
				"duplicate",
				"unread",
			] as const) {
				const hostile = structuredClone(evidence);
				if (invalid === "request") Object.assign(hostile.commits[0], { requestId: "foreign" });
				if (invalid === "mailbox")
					Object.assign(hostile.commits[0].entries[0].record, { recipientIdentity: "foreign" });
				if (invalid === "anchor") Object.assign(hostile.commits[0].entries[0].record, { branchAnchor: "missing" });
				if (invalid === "provenance")
					Object.assign(hostile.commits[0].entries[0].record, { provenance: { senderIdentity: "other" } });
				if (invalid === "view") Object.assign(hostile.view, { sessionId: "foreign" });
				if (invalid === "body") Object.assign(hostile.commits[0].entries[0].record, { envelope: "forged body" });
				if (invalid === "entry-id") Object.assign(hostile.commits[0].entries[0], { entryId: "other" });
				if (invalid === "duplicate")
					Object.assign(hostile.commits[0].entries[1], { entryId: hostile.commits[0].entries[0].entryId });
				if (invalid === "unread" && hostile.view.verified)
					Object.assign(hostile.view.events[0], { state: "pending" });
				const mock = vi.spyOn(recovered, "recover").mockResolvedValueOnce(hostile);
				await expect(fresh.session.requestAdmission.reconcile()).rejects.toThrow();
				expect(readFileSync(file)).toEqual(repaired);
				expect(reopened.getLeafId()).toBe(sibling);
				mock.mockRestore();
			}
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(stream).not.toHaveBeenCalled();
			fresh.setResponses([fauxAssistantMessage("explicit response")]);
			await fresh.session.prompt("explicit new request");
			expect(fresh.faux.state.callCount).toBe(1);
			expect(stream).toHaveBeenCalledTimes(1);
			expect(JSON.stringify(stream.mock.calls[0][1].messages)).toContain("explicit new request");
			expect(JSON.stringify(stream.mock.calls[0][1].messages)).not.toContain("RECOVER_ONE");
		} finally {
			fresh?.cleanup();
			fixture.cleanup();
		}
	});
});
