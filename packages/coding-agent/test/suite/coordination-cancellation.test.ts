import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, lazyStream } from "@earendil-works/pi-ai";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "../../src/core/extensions/types.ts";
import { readExternalEntry } from "../../src/core/external-event-records.ts";
import { RequestAdmissionOwner } from "../../src/core/request-admission.ts";
import { RuntimeIncarnation } from "../../src/core/runtime-incarnation.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createCoordinationHarness, expectOneAdmission } from "../helpers/coordination.ts";
import { savedFixture } from "../helpers/external-events.ts";
import { FakeRequestCoordinator } from "../helpers/fake-request-coordinator.ts";
import { FakeRuntimeCoordinator } from "../helpers/fake-runtime-coordinator.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "../model-runtime-test-utils.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { createTestUiContext } from "./harness.ts";

async function createSdkDispatchFixture(factory?: ExtensionFactory) {
	const saved = savedFixture();
	const faux = fauxProvider();
	const registry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	const runtime = getModelRuntime(registry);
	let setup = 0;
	let invoked = 0;
	const settlements: string[] = [];
	let adoptions = 0;

	runtime.registerNativeProvider({
		...faux.provider,
		streamSimple(model, context, options) {
			setup++;
			return lazyStream(model, async () => {
				const payload = { messages: structuredClone(context.messages) };
				await options?.onPayload?.(payload, model);
				invoked++;
				return faux.provider.streamSimple(model, context, options);
			});
		},
	});

	const extensions = await createTestExtensionsResult(factory ? [factory] : [], saved.directory);
	const resourceLoader = createTestResourceLoader({ extensionsResult: extensions });
	const { session } = await createAgentSession({
		cwd: saved.directory,
		agentDir: saved.directory,
		model: faux.getModel(),
		modelRuntime: runtime,
		settingsManager: SettingsManager.inMemory({ cacheWarming: "off" }),
		sessionManager: saved.manager,
		resourceLoader,
		noTools: "all",
	});

	if (!(session.requestAdmission instanceof RequestAdmissionOwner)) {
		throw new Error("Expected RequestAdmissionOwner");
	}
	const owner = session.requestAdmission;
	const origFinalize = owner.finalize.bind(owner);
	vi.spyOn(owner, "finalize").mockImplementation(async (...args) => {
		const result = await origFinalize(...args);
		if (!result) return result;
		return {
			...result,
			onAssistantStart: () => {
				adoptions++;
				result.onAssistantStart();
			},
			settle: async (outcome) => {
				settlements.push(outcome);
				await result.settle(outcome);
			},
		};
	});

	await session.bindExtensions({});
	const authority = new FakeRuntimeCoordinator();
	session.runtimeLifecycle.participate();
	await session.runtimeLifecycle.reconcile(authority.exchange);
	const coordinator = new FakeRequestCoordinator(
		authority,
		undefined,
		undefined,
		session.runtimeLifecycle.capture().mailboxId,
	);
	session.coordinationScheduler.bind(coordinator);

	const suppressedReasons: string[] = [];
	session.subscribe((event) => {
		if (event.type === "request_suppressed") suppressedReasons.push(event.reason);
	});
	faux.setResponses([fauxAssistantMessage("done")]);

	return {
		session,
		manager: saved.manager,
		coordinator,
		authority,
		faux,
		runtime,
		suppressedReasons,
		settlements,
		setup: () => setup,
		invoked: () => invoked,
		adoptions: () => adoptions,
		cleanup: () => {
			session.dispose();
			saved.cleanup();
		},
	};
}

function expectSavedToolPairing(
	sessionFile: string | undefined,
	expectedPairs: ReadonlyArray<{
		toolCallId: string;
		toolName: string;
		textContains: string;
		forbiddenSubstrings?: readonly string[];
	}>,
): SessionManager {
	expect(sessionFile).toBeTruthy();
	expect(expectedPairs.length).toBeGreaterThan(0);

	const reopened = SessionManager.open(sessionFile!);
	const branch = reopened.getBranch();

	const savedCalls: Array<{ id: string; name: string; entryIndex: number; entryId: string }> = [];
	const savedResults: Array<{
		toolCallId: string;
		toolName: string;
		serialized: string;
		entryIndex: number;
		entryId: string;
	}> = [];

	branch.forEach((entry, entryIndex) => {
		if (entry.type !== "message") return;
		const msg = entry.message;
		if (msg.role === "assistant") {
			for (const block of msg.content) {
				if (block.type === "toolCall") {
					savedCalls.push({
						id: block.id,
						name: block.name,
						entryIndex,
						entryId: entry.id,
					});
				}
			}
		} else if (msg.role === "toolResult") {
			savedResults.push({
				toolCallId: msg.toolCallId,
				toolName: msg.toolName,
				serialized: JSON.stringify(msg.content),
				entryIndex,
				entryId: entry.id,
			});
		}
	});

	expect(savedCalls).toHaveLength(expectedPairs.length);
	expect(savedResults).toHaveLength(expectedPairs.length);
	expect(new Set(savedCalls.map((c) => c.id)).size).toBe(savedCalls.length);
	expect(new Set(savedResults.map((r) => r.toolCallId)).size).toBe(savedResults.length);
	expect(savedCalls.map((c) => ({ id: c.id, name: c.name }))).toEqual(
		expectedPairs.map((p) => ({ id: p.toolCallId, name: p.toolName })),
	);
	expect(savedResults.map((r) => ({ id: r.toolCallId, name: r.toolName }))).toEqual(
		expectedPairs.map((p) => ({ id: p.toolCallId, name: p.toolName })),
	);

	for (let i = 0; i < expectedPairs.length; i++) {
		const expected = expectedPairs[i]!;
		const call = savedCalls[i]!;
		const result = savedResults[i]!;
		expect(result.entryIndex).toBeGreaterThan(call.entryIndex);
		expect(result.serialized).toContain(expected.textContains);
		for (const forbidden of expected.forbiddenSubstrings ?? []) {
			expect(result.serialized).not.toContain(forbidden);
		}
	}

	return reopened;
}

describe("Task 8: destructive cancellation and wake race matrix", () => {
	const cleanups: Array<() => void> = [];
	afterEach(() => {
		vi.restoreAllMocks();
		for (const fn of cleanups.splice(0)) fn();
	});

	it("Row 1: Esc before eligible event, then late event/refresh", async () => {
		const fixture = await createCoordinationHarness();
		cleanups.push(fixture.cleanup);
		const { harness, coordinator, scheduler } = fixture;
		scheduler.bind(coordinator);

		const prepareSpy = vi.spyOn(harness.session.requestAdmission as RequestAdmissionOwner, "prepare");
		const streamSpy = vi.spyOn(harness.session.agent, "streamFunction");

		const receipt = await scheduler.grant({ kind: "job", attemptId: "job-row1" });
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "armed" }]);

		// Esc before event arrives
		scheduler.cancel();
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "revoked" }]);

		// Late event arrives and refresh runs
		const event = coordinator.seedEvent("row1-event", "ROW1_PRIVATE_BODY");
		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-row1" },
		});
		await scheduler.refresh();
		await scheduler.reconcile();

		expect(prepareSpy).toHaveBeenCalledTimes(0);
		expect(streamSpy).toHaveBeenCalledTimes(0);
		expect(harness.faux.state.callCount).toBe(0);
		expect(coordinator.inspectEvent(event)?.state).toBe("pending");
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "revoked" }]);
	});

	it("Row 2: Esc after claim queued but before actual start", async () => {
		const fixture = await createCoordinationHarness();
		cleanups.push(fixture.cleanup);
		const { harness, coordinator, scheduler } = fixture;
		scheduler.bind(coordinator);

		const prepareSpy = vi.spyOn(harness.session.requestAdmission as RequestAdmissionOwner, "prepare");
		const streamSpy = vi.spyOn(harness.session.agent, "streamFunction");

		const event = coordinator.seedEvent("row2-event", "ROW2_PRIVATE_BODY");
		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-row2" },
		});

		// Grant returns eligible and queues the idle reconsideration microtask,
		// then cancel() runs synchronously before the queued microtask executes
		const receipt = await scheduler.grant({ kind: "job", attemptId: "job-row2" });
		scheduler.cancel();

		// Flush microtasks and refresh
		await scheduler.refresh();
		await harness.session.waitForIdle();

		expect(prepareSpy).toHaveBeenCalledTimes(0);
		expect(streamSpy).toHaveBeenCalledTimes(0);
		expect(harness.faux.state.callCount).toBe(0);
		expect(coordinator.inspectEvent(event)?.state).toBe("pending");
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "revoked" }]);
	});

	it("Row 3: Overlay Esc during unrelated final text with armed grant", async () => {
		const fixture = await createCoordinationHarness();
		cleanups.push(fixture.cleanup);
		const { harness, coordinator, scheduler } = fixture;
		scheduler.bind(coordinator);

		const receipt = await scheduler.grant({ kind: "job", attemptId: "job-row3" });
		const streamEntered = Promise.withResolvers<void>();
		const streamRelease = Promise.withResolvers<void>();

		harness.setResponses([
			async () => {
				streamEntered.resolve();
				await streamRelease.promise;
				return fauxAssistantMessage("UNRELATED_FINAL_TEXT_INTACT");
			},
			fauxAssistantMessage("should not run wake continuation"),
		]);

		const running = harness.session.prompt("unrelated user prompt");
		await streamEntered.promise;

		// Event becomes eligible while unrelated final text is streaming
		const event = coordinator.seedEvent("row3-event", "ROW3_PRIVATE_BODY");
		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-row3" },
		});
		await scheduler.refresh();
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "eligible" }]);

		// Overlay Esc calls scheduler.cancel() without aborting the active natural stream
		scheduler.cancel();
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "revoked" }]);

		// Release stream: original 1 call finishes; no target continuation runs
		streamRelease.resolve();
		await running;
		await harness.session.waitForIdle();

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.getLastAssistantText()).toBe("UNRELATED_FINAL_TEXT_INTACT");
		expect(coordinator.inspectEvent(event)?.state).toBe("pending");
	});

	it("Row 4: Wait match committed, local response held, then Esc (including after prior epoch advance and after wait returned before assistant start)", async () => {
		const waitHeldEntered = Promise.withResolvers<void>();
		const waitHeldRelease = Promise.withResolvers<void>();
		const waitReturned2 = Promise.withResolvers<string>();
		const postWaitToolEntered = Promise.withResolvers<void>();
		const postWaitToolRelease = Promise.withResolvers<void>();

		const fixture = await createCoordinationHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "wait_peer",
						label: "Wait Peer",
						description: "waits for peer",
						parameters: Type.Object({ attemptId: Type.String() }),
						async execute(_id, params) {
							const outcome = await fixture.scheduler.wait(
								{ kind: "job", attemptId: params.attemptId },
								Date.now() + 60_000,
							);
							if (params.attemptId === "job-row4-2") {
								waitReturned2.resolve(outcome.status);
							}
							return {
								content: [{ type: "text", text: `wait:${outcome.status}` }],
								details: { outcome },
							};
						},
					});
					pi.registerTool({
						name: "sibling_hold",
						label: "Sibling Hold",
						description: "holds after wait returned",
						parameters: Type.Object({}),
						async execute() {
							postWaitToolEntered.resolve();
							await postWaitToolRelease.promise;
							return { content: [{ type: "text", text: "sibling-done" }], details: {} };
						},
					});
				},
			],
		});
		cleanups.push(fixture.cleanup);
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		// Advance permissionEpoch to 1 first so we prove cancel works at epoch >= 1
		await scheduler.grant({ kind: "job", attemptId: "job-row4-initial-epoch" });
		scheduler.cancel();
		expect(scheduler.inspect().permissionEpoch).toBe(1);

		// Hold local wait response delivery after remote wait commits match
		let capturedWaitId1 = "";
		const origWait = coordinator.wait.bind(coordinator);
		vi.spyOn(coordinator, "wait").mockImplementation(async (op, signal) => {
			capturedWaitId1 = op.operationId;
			const res = await origWait(op, signal);
			waitHeldEntered.resolve();
			await waitHeldRelease.promise;
			return res;
		});

		const event1 = coordinator.seedEvent("row4-event-1", "ROW4_BODY_1");
		coordinator.omitOrdinaryCandidate(event1);
		coordinator.coordination.record({
			reference: event1,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-row4-1" },
		});

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait_peer", { attemptId: "job-row4-1" }, { id: "tc-row4-1" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("should not run after Esc during held wait response"),
		]);

		const run1 = harness.session.prompt("wait 1");
		await waitHeldEntered.promise;

		// Remote wait already committed matched, local response is held -> press Esc
		expect(coordinator.coordination.inspectWait(capturedWaitId1)).toMatchObject({
			result: { status: "matched", reference: { eventId: "row4-event-1" } },
			terminalCount: 1,
		});
		scheduler.cancel();
		expect(scheduler.inspect().permissionEpoch).toBe(2);

		waitHeldRelease.resolve();
		await run1;
		await harness.session.waitForIdle();

		// Initial 1 call only; remote matched retained; local continuation suppressed; saved toolResult is interrupted
		expect(harness.faux.state.callCount).toBe(1);
		expect(coordinator.inspectEvent(event1)?.state).toBe("pending");
		expect(coordinator.coordination.inspectWait(capturedWaitId1)).toMatchObject({
			result: { status: "matched", reference: { eventId: "row4-event-1" } },
			terminalCount: 1,
		});
		expectSavedToolPairing(manager.getSessionFile(), [
			{
				toolCallId: "tc-row4-1",
				toolName: "wait_peer",
				textContains: "wait:interrupted",
				forbiddenSubstrings: ["ROW4_BODY_1"],
			},
		]);

		// Subcase 4b: wait already returned matched, then Esc fires before next turn's assistant start (during sibling tool)
		vi.restoreAllMocks();
		const event2 = coordinator.seedEvent("row4-event-2", "ROW4_BODY_2");
		coordinator.omitOrdinaryCandidate(event2);
		coordinator.coordination.record({
			reference: event2,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-row4-2" },
		});

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("wait_peer", { attemptId: "job-row4-2" }, { id: "tc-wait" }),
					fauxToolCall("sibling_hold", {}, { id: "tc-sib" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("should not run after Esc following returned wait"),
		]);

		const run2 = harness.session.prompt("wait 2 with sibling");
		const [returnedStatus] = await Promise.all([waitReturned2.promise, postWaitToolEntered.promise]);
		expect(returnedStatus).toBe("matched");

		// wait_peer has ALREADY returned matched, now cancel() before Turn 2 starts
		scheduler.cancel();
		expect(scheduler.inspect().permissionEpoch).toBe(3);

		postWaitToolRelease.resolve();
		await run2;
		await harness.session.waitForIdle();

		// Only 1 call for run2 (2 total across both runs); event2 remains pending;
		// already-returned matched toolResult is preserved (not rewritten to interrupted) and paired alongside sibling
		expect(harness.faux.state.callCount).toBe(2);
		expect(coordinator.inspectEvent(event2)?.state).toBe("pending");
		expectSavedToolPairing(manager.getSessionFile(), [
			{
				toolCallId: "tc-row4-1",
				toolName: "wait_peer",
				textContains: "wait:interrupted",
				forbiddenSubstrings: ["ROW4_BODY_1"],
			},
			{
				toolCallId: "tc-wait",
				toolName: "wait_peer",
				textContains: "wait:matched",
				forbiddenSubstrings: ["ROW4_BODY_2"],
			},
			{
				toolCallId: "tc-sib",
				toolName: "sibling_hold",
				textContains: "sibling-done",
			},
		]);
	});

	it("Row 5: Esc first, then same-deadline match/timeout", async () => {
		let now = 10_000;
		const waitEntered = Promise.withResolvers<void>();
		const fixture = await createCoordinationHarness({
			clock: () => now,
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "wait_row5",
						label: "Wait Row 5",
						description: "waits",
						parameters: Type.Object({}),
						async execute() {
							const p = fixture.scheduler.wait({ kind: "job", attemptId: "job-row5" }, now + 500);
							waitEntered.resolve();
							const out = await p;
							return { content: [{ type: "text", text: `status:${out.status}` }], details: { out } };
						},
					});
				},
			],
		});
		cleanups.push(fixture.cleanup);
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		let row5WaitId = "";
		const origWait5 = coordinator.wait.bind(coordinator);
		vi.spyOn(coordinator, "wait").mockImplementation(async (op, signal) => {
			row5WaitId = op.operationId;
			return await origWait5(op, signal);
		});

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait_row5", {}, { id: "call-row5" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("should not revive on deadline or match after Esc"),
		]);

		const running = harness.session.prompt("start row 5");
		await waitEntered.promise;

		// Esc first
		scheduler.cancel();
		await running;
		await harness.session.waitForIdle();

		expect(harness.faux.state.callCount).toBe(1);
		expect(coordinator.coordination.inspectWait(row5WaitId)).toMatchObject({
			result: { status: "interrupted", reason: "cancelled" },
			terminalCount: 1,
		});
		expectSavedToolPairing(manager.getSessionFile(), [
			{
				toolCallId: "call-row5",
				toolName: "wait_row5",
				textContains: "status:interrupted",
				forbiddenSubstrings: ["ROW5_BODY"],
			},
		]);

		// Now advance clock past deadline AND record a matching event
		now += 1_000;
		const event = coordinator.seedEvent("row5-event", "ROW5_BODY");
		coordinator.coordination.record({
			reference: event,
			recordedAt: now,
			match: { kind: "job", attemptId: "job-row5" },
		});
		coordinator.coordination.finishDue();
		await scheduler.refresh();

		// Still 1 remote terminal result (interrupted), zero revival, and no second saved toolResult
		expect(coordinator.coordination.inspectWait(row5WaitId)).toMatchObject({
			result: { status: "interrupted", reason: "cancelled" },
			terminalCount: 1,
		});
		expect(harness.faux.state.callCount).toBe(1);
		expectSavedToolPairing(manager.getSessionFile(), [
			{
				toolCallId: "call-row5",
				toolName: "wait_row5",
				textContains: "status:interrupted",
				forbiddenSubstrings: ["ROW5_BODY"],
			},
		]);
	});

	it("Row 6: Timeout or unanswerable first with no Esc", async () => {
		let now = 20_000;
		const wait1Entered = Promise.withResolvers<void>();
		const wait2Entered = Promise.withResolvers<void>();
		const fixture = await createCoordinationHarness({
			clock: () => now,
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "wait_row6",
						label: "Wait Row 6",
						description: "waits",
						parameters: Type.Object({ attemptId: Type.String() }),
						async execute(_id, params) {
							const target =
								params.attemptId === "q-row6"
									? ({
											kind: "reply",
											questionId: "q-row6",
											addressedIdentity: "peer-a",
										} as const)
									: ({ kind: "job", attemptId: params.attemptId } as const);
							const p = fixture.scheduler.wait(target, now + 500);
							if (params.attemptId === "job-timeout") wait1Entered.resolve();
							else wait2Entered.resolve();
							const out = await p;
							return { content: [{ type: "text", text: `status:${out.status}` }], details: { out } };
						},
					});
				},
			],
		});
		cleanups.push(fixture.cleanup);
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		// 6a. Timeout with no Esc -> exactly 2 calls total
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait_row6", { attemptId: "job-timeout" }, { id: "call-row6-timeout" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("resumed once after timeout"),
		]);
		const run1 = harness.session.prompt("wait for timeout");
		await wait1Entered.promise;
		now += 600;
		coordinator.coordination.finishDue();
		await run1;
		expect(harness.faux.state.callCount).toBe(2);

		// 6b. Unanswerable with no Esc -> exactly 2 calls for this run (4 total)
		coordinator.coordination.registerQuestion("q-row6", fixture.fence.mailboxId, "peer-a", now + 10_000);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait_row6", { attemptId: "q-row6" }, { id: "call-row6-unanswerable" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("resumed once after unanswerable"),
		]);
		const run2 = harness.session.prompt("wait for unanswerable");
		await wait2Entered.promise;
		coordinator.coordination.makeUnanswerable("q-row6", "parent-closed");
		await run2;
		expect(harness.faux.state.callCount).toBe(4);

		const reopened6 = expectSavedToolPairing(manager.getSessionFile(), [
			{
				toolCallId: "call-row6-timeout",
				toolName: "wait_row6",
				textContains: "status:timeout",
			},
			{
				toolCallId: "call-row6-unanswerable",
				toolName: "wait_row6",
				textContains: "status:unanswerable",
			},
		]);
		const serializedBranch6 = JSON.stringify(reopened6.getBranch());
		expect(serializedBranch6).toContain("resumed once after timeout");
		expect(serializedBranch6).toContain("resumed once after unanswerable");
	});

	it("Row 7: Permission cancellation RPC disconnected/rejected and retried on original adapter", async () => {
		const fixture = await createCoordinationHarness();
		cleanups.push(fixture.cleanup);
		const { harness, coordinator, runtimeCoordinator, scheduler } = fixture;
		const unbindA = scheduler.bind(coordinator);

		const receipt = await scheduler.grant({ kind: "job", attemptId: "job-row7" });
		const event = coordinator.seedEvent("row7-event", "ROW7_BODY");
		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-row7" },
		});

		let failCancelA = true;
		const origCancelA = coordinator.cancelPermissions.bind(coordinator);
		const cancelOpsA: string[] = [];
		vi.spyOn(coordinator, "cancelPermissions").mockImplementation(async (op) => {
			cancelOpsA.push(op.operationId);
			if (failCancelA) throw new Error("Coordinator A offline");
			return await origCancelA(op);
		});

		// Cancel while Coordinator A rejects cancelPermissions
		scheduler.cancel();
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "revoked" }]);
		expect(harness.faux.state.callCount).toBe(0);
		expect(cancelOpsA).toHaveLength(1);

		// Rebind to a second coordinator B, then reconcile: pending cancellation for A must still retry on A!
		unbindA();
		const coordinatorB = new FakeRequestCoordinator(
			runtimeCoordinator,
			undefined,
			undefined,
			fixture.fence.mailboxId,
		);
		const cancelSpyB = vi.spyOn(coordinatorB, "cancelPermissions");
		scheduler.bind(coordinatorB);

		failCancelA = false;
		await scheduler.reconcile();

		expect(cancelOpsA).toHaveLength(2);
		expect(cancelOpsA[0]).toBe(cancelOpsA[1]);
		expect(cancelSpyB).toHaveBeenCalledTimes(0);
		expect(coordinator.coordination.inspectGrant(receipt.grantId)?.state).toBe("revoked");
	});

	it("Row 8: Grant creation committed after Esc / late eligible snapshot (including after prior epoch advance)", async () => {
		const fixture = await createCoordinationHarness();
		cleanups.push(fixture.cleanup);
		const { harness, coordinator, scheduler } = fixture;
		scheduler.bind(coordinator);

		// Advance permissionEpoch to 1 first
		await scheduler.grant({ kind: "job", attemptId: "job-row8-warmup" });
		scheduler.cancel();
		expect(scheduler.inspect().permissionEpoch).toBe(1);

		const grantEntered = Promise.withResolvers<void>();
		const grantRelease = Promise.withResolvers<void>();
		const origGrant = coordinator.grant.bind(coordinator);
		vi.spyOn(coordinator, "grant").mockImplementation(async (op, signal) => {
			// Authority commits the grant at epoch 1, then response is held across Esc
			const res = await origGrant(op, signal);
			grantEntered.resolve();
			await grantRelease.promise;
			return res;
		});

		const event = coordinator.seedEvent("row8-event", "ROW8_BODY");
		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-row8-late" },
		});

		const pendingGrant = scheduler.grant({ kind: "job", attemptId: "job-row8-late" });
		await grantEntered.promise;

		// Cancel while grant RPC is in flight at epoch 1
		scheduler.cancel();
		expect(scheduler.inspect().permissionEpoch).toBe(2);

		grantRelease.resolve();
		await expect(pendingGrant).rejects.toThrow("Scope changed during grant");

		// Even if refresh runs, lower permission epoch cannot restore permission or trigger a call
		await scheduler.refresh();
		expect(harness.faux.state.callCount).toBe(0);
		expect(coordinator.inspectEvent(event)?.state).toBe("pending");
	});

	it("Row 9: Canonical receipt held before final admission, then cancel", async () => {
		const fixture = await createCoordinationHarness();
		cleanups.push(fixture.cleanup);
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		const deliveredEntered = Promise.withResolvers<void>();
		const deliveredRelease = Promise.withResolvers<void>();
		const origDelivered = coordinator.delivered.bind(coordinator);
		vi.spyOn(coordinator, "delivered").mockImplementation(async (req, receipts, sig) => {
			const res = await origDelivered(req, receipts, sig);
			deliveredEntered.resolve();
			await deliveredRelease.promise;
			return res;
		});
		const admitSpy = vi.spyOn(coordinator, "admit");

		const event = coordinator.seedEvent("row9-event", "ROW9_CANONICAL_BODY");
		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-row9" },
		});
		const receipt = await scheduler.grant({ kind: "job", attemptId: "job-row9" });

		await deliveredEntered.promise;

		// Cancel while held at delivered (after canonical entry appended locally, before final admission)
		scheduler.cancel();
		deliveredRelease.resolve();
		await harness.session.waitForIdle();

		expect(admitSpy).toHaveBeenCalledTimes(0);
		expect(harness.faux.state.callCount).toBe(0);
		expect(coordinator.inspectEvent(event)?.state).toBe("pending");
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "revoked" }]);

		// Canonical record is retained locally and admitted on the next user prompt
		expect(
			manager.getEntries().some((e) => {
				const rec = readExternalEntry(e);
				return rec?.kind === "canonical" && rec.eventId === "row9-event";
			}),
		).toBe(true);

		harness.setResponses([fauxAssistantMessage("next user prompt admits retained canonical")]);
		await harness.session.prompt("next prompt");
		expect(harness.faux.state.callCount).toBe(1);
		expectOneAdmission(manager, event);
	});

	it("Row 10: Admission already in flight, commit before cancellation", async () => {
		const fixture = await createCoordinationHarness();
		cleanups.push(fixture.cleanup);
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		const event = coordinator.seedEvent("row10-event", "ROW10_COMMITTED_BODY");
		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-row10" },
		});

		const gate = coordinator.holdNextAdmission();
		const admitSpy = vi.spyOn(coordinator, "admit");
		const streamSpy = vi.spyOn(harness.session.agent, "streamFunction");

		const receipt = await scheduler.grant({ kind: "job", attemptId: "job-row10" });
		await gate.received;
		const rootLeaf = manager.getLeafId();

		// Authority commits BEFORE local cancellation
		gate.commit();
		await gate.committed;

		const aborting = harness.session.abort();
		const requestId = admitSpy.mock.calls[0][0].request.requestId;
		const committedResult = coordinator.inspectRequest(requestId)?.result;

		gate.respond();
		await aborting;
		await harness.session.waitForIdle();

		// Read AND grant consumed retained; zero dispatch after cancel; suppressed recorded on original adapter
		expect(streamSpy).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(0);
		expect(coordinator.inspectEvent(event)?.state).toBe("read");
		expect(coordinator.coordination.inspectGrant(receipt.grantId)?.state).toBe("consumed");
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "consumed" }]);
		expect(coordinator.inspectRequest(requestId)?.suppressed).toBe(true);
		expect(committedResult?.entries).toHaveLength(1);
		expect(manager.getEntry(committedResult!.entries[0].entryId)).toBeDefined();
		expect(manager.getLeafId()).toBe(rootLeaf);

		const reopened = SessionManager.open(manager.getSessionFile()!);
		expect(reopened.getLeafId()).toBe(rootLeaf);
		expect(reopened.getEntry(committedResult!.entries[0].entryId)).toBeDefined();
	});

	it("Row 11: Cancellation reaches authority before in-flight commit", async () => {
		const fixture = await createCoordinationHarness();
		cleanups.push(fixture.cleanup);
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		const event = coordinator.seedEvent("row11-event", "ROW11_BODY");
		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-row11" },
		});

		const gate = coordinator.holdNextAdmission();
		const streamSpy = vi.spyOn(harness.session.agent, "streamFunction");

		const receipt = await scheduler.grant({ kind: "job", attemptId: "job-row11" });
		await gate.received;
		const rootLeaf = manager.getLeafId();

		// Cancellation reaches authority BEFORE gate.commit()
		scheduler.cancel();
		expect(coordinator.coordination.inspectGrant(receipt.grantId)?.state).toBe("revoked");

		gate.commit();
		await expect(gate.committed).rejects.toThrow("Activation scope does not match runtime fence");
		await harness.session.waitForIdle();

		// No new read/consumption, zero dispatch; definite rejection is not replay permission
		expect(streamSpy).not.toHaveBeenCalled();
		expect(harness.faux.state.callCount).toBe(0);
		expect(coordinator.inspectEvent(event)?.state).toBe("pending");
		expect(coordinator.coordination.inspectGrant(receipt.grantId)?.state).toBe("revoked");
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "revoked" }]);
		expect(manager.getLeafId()).toBe(rootLeaf);
	});

	it.each(["append", "auth", "headers", "payload"] as const)(
		"Row 12a (%s): Known wake commit, held pi append/SDK auth/header/payload, then actual abort",
		async (boundary) => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();

			const f = await createSdkDispatchFixture((pi) => {
				pi.on("before_provider_headers", async () => {
					if (boundary === "headers") {
						entered.resolve();
						await release.promise;
					}
				});
				pi.on("before_provider_request", async () => {
					if (boundary === "payload") {
						entered.resolve();
						await release.promise;
					}
				});
			});
			cleanups.push(f.cleanup);

			const event = f.coordinator.seedEvent(`row12a-${boundary}`, `ROW12A_${boundary}`);
			f.coordinator.coordination.record({
				reference: event,
				recordedAt: Date.now(),
				match: { kind: "job", attemptId: `job-12a-${boundary}` },
			});

			const admitSpy = vi.spyOn(f.coordinator, "admit");
			let aborting: Promise<void> | undefined;

			if (boundary === "append") {
				const origAppend = f.manager.appendAdmissionBatchOnce.bind(f.manager);
				vi.spyOn(f.manager, "appendAdmissionBatchOnce").mockImplementation((entries) => {
					const res = origAppend(entries);
					aborting = f.session.abort();
					entered.resolve();
					return res;
				});
			} else if (boundary === "auth") {
				const origAuth = f.runtime.getAuth.bind(f.runtime);
				vi.spyOn(f.runtime, "getAuth").mockImplementation(async (...args) => {
					entered.resolve();
					await release.promise;
					return await origAuth(...args);
				});
			}

			const receipt = await f.session.coordinationScheduler.grant({
				kind: "job",
				attemptId: `job-12a-${boundary}`,
			});
			await entered.promise;

			if (boundary !== "append") {
				aborting = f.session.abort();
				release.resolve();
			}
			await aborting;
			await f.session.waitForIdle();

			const requestId = admitSpy.mock.calls[0][0].request.requestId;
			const branchAnchor = admitSpy.mock.calls[0][0].request.branchAnchor;
			expect(f.invoked()).toBe(0);
			expect(f.faux.state.callCount).toBe(0);
			expect(f.coordinator.inspectEvent(event)?.state).toBe("read");
			expect(f.coordinator.coordination.inspectGrant(receipt.grantId)?.state).toBe("consumed");
			if (boundary === "append") {
				expect(f.coordinator.inspectRequest(requestId)?.suppressed).toBe(true);
			} else {
				expect(f.settlements).toEqual(["dispatch-uncertain"]);
			}
			expect(f.manager.getLeafId()).toBe(branchAnchor);

			const reopened = SessionManager.open(f.manager.getSessionFile()!);
			expect(reopened.getLeafId()).toBe(branchAnchor);
		},
	);

	it.each(["auth", "headers", "payload"] as const)(
		"Row 12b (%s): Known wake commit, held SDK auth/header/payload, then overlay-only scheduler.cancel",
		async (boundary) => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();

			const f = await createSdkDispatchFixture((pi) => {
				pi.on("before_provider_headers", async () => {
					if (boundary === "headers") {
						entered.resolve();
						await release.promise;
					}
				});
				pi.on("before_provider_request", async () => {
					if (boundary === "payload") {
						entered.resolve();
						await release.promise;
					}
				});
			});
			cleanups.push(f.cleanup);

			const event = f.coordinator.seedEvent(`row12b-${boundary}`, `ROW12B_${boundary}`);
			f.coordinator.coordination.record({
				reference: event,
				recordedAt: Date.now(),
				match: { kind: "job", attemptId: `job-12b-${boundary}` },
			});

			if (boundary === "auth") {
				const origAuth = f.runtime.getAuth.bind(f.runtime);
				vi.spyOn(f.runtime, "getAuth").mockImplementation(async (...args) => {
					entered.resolve();
					await release.promise;
					return await origAuth(...args);
				});
			}

			// Advance permissionEpoch above 0 via a real prior grant + cancel so the epoch-0 fallback cannot mask this
			const priorReceipt = await f.session.coordinationScheduler.grant({
				kind: "job",
				attemptId: `job-12b-prior-${boundary}`,
			});
			f.session.coordinationScheduler.cancel();
			expect(f.session.coordinationScheduler.inspect()).toMatchObject({
				permissionEpoch: 1,
				grants: [{ grantId: priorReceipt.grantId, state: "revoked" }],
			});

			const admitSpy = vi.spyOn(f.coordinator, "admit");
			const cancelSpy = vi.spyOn(f.coordinator, "cancelPermissions");
			const fenceBefore = f.session.runtimeLifecycle.capture();
			await f.session.coordinationScheduler.grant({
				kind: "job",
				attemptId: `job-12b-${boundary}`,
			});
			await entered.promise;

			// Overlay-only Esc calls coordinationScheduler.cancel() WITHOUT rotating RuntimeFence,
			// and repeat Esc is idempotent (only 1 new cancelPermissions RPC)
			f.session.coordinationScheduler.cancel();
			f.session.coordinationScheduler.cancel();
			expect(f.session.coordinationScheduler.inspect().permissionEpoch).toBe(2);
			expect(cancelSpy).toHaveBeenCalledTimes(1);
			expect(f.session.runtimeLifecycle.isCurrent(fenceBefore)).toBe(true);

			release.resolve();
			await f.session.waitForIdle();

			const branchAnchor = admitSpy.mock.calls[0][0].request.branchAnchor;
			// Guard catches stale activation permissionEpoch after commit and suppresses before provider invoke!
			expect(f.invoked()).toBe(0);
			expect(f.faux.state.callCount).toBe(0);
			expect(f.adoptions()).toBe(0);
			expect(f.coordinator.inspectEvent(event)?.state).toBe("read");
			expect(f.suppressedReasons).toContain("coordination-stale");
			expect(f.manager.getLeafId()).toBe(branchAnchor);

			const reopened = SessionManager.open(f.manager.getSessionFile()!);
			expect(reopened.getLeafId()).toBe(branchAnchor);
		},
	);

	it("Row 12c: Wake-started response handoff survives post-start permission cancel and preserves owned partial text on real session.abort", async () => {
		const fixture = await createCoordinationHarness();
		cleanups.push(fixture.cleanup);
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		// Advance permissionEpoch to 1 via prior grant + cancel
		const priorReceipt = await scheduler.grant({ kind: "job", attemptId: "job-row12c-prior" });
		scheduler.cancel();
		expect(scheduler.inspect().permissionEpoch).toBe(1);

		const event = coordinator.seedEvent("row12c-event", "ROW12C_WAKE_BODY");
		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-row12c" },
		});

		harness.setResponses([fauxAssistantMessage("WAKE_PARTIAL_OWNED_TEXT")]);

		const origStream = harness.session.agent.streamFunction;
		const partialStarted = Promise.withResolvers<void>();
		const partialRelease = Promise.withResolvers<void>();

		harness.session.agent.streamFunction = async (...args) => {
			const stream = await origStream(...args);
			const iterator = stream[Symbol.asyncIterator]();
			let first = true;
			Object.defineProperty(stream, Symbol.asyncIterator, {
				value: () => ({
					next: async () => {
						if (first) {
							first = false;
							return await iterator.next();
						}
						partialStarted.resolve();
						await partialRelease.promise;
						return await iterator.next();
					},
				}),
			});
			return stream;
		};

		const receipt = await scheduler.grant({ kind: "job", attemptId: "job-row12c" });
		await partialStarted.promise;

		// 1. After assistantStarted() handoff, pendingActivation is retired so empty scheduler.cancel() is a no-op
		scheduler.cancel();
		expect(scheduler.inspect().permissionEpoch).toBe(1);

		// 2. Even if a new armed grant is cancelled after assistantStarted() (advancing permissionEpoch to 2),
		// the already-started assistant owns the request and is not suppressed by permissionEpoch rotation!
		const postStartArmed = await scheduler.grant({ kind: "job", attemptId: "job-row12c-post-start" });
		scheduler.cancel();
		expect(scheduler.inspect().permissionEpoch).toBe(2);

		// 3. Now perform a real session.abort(): owned partial text is preserved on the adopted admission tip!
		const adoptedLeaf = manager.getLeafId();
		const aborting = harness.session.abort();
		partialRelease.resolve();
		await aborting;
		await harness.session.waitForIdle();

		expect(harness.faux.state.callCount).toBe(1);
		expect(coordinator.inspectEvent(event)?.state).toBe("read");
		expect(scheduler.inspect().grants).toEqual([
			{ grantId: priorReceipt.grantId, state: "revoked" },
			{ grantId: receipt.grantId, state: "consumed" },
			{ grantId: postStartArmed.grantId, state: "revoked" },
		]);

		// First-owned assistant message is preserved on the adopted admission tip
		const branchAssistants = manager
			.getBranch()
			.filter((e) => e.type === "message" && e.message.role === "assistant");
		expect(branchAssistants).toHaveLength(2);
		expect(branchAssistants[1].parentId).toBe(adoptedLeaf);

		const reopened = SessionManager.open(manager.getSessionFile()!);
		expect(reopened.getEntry(branchAssistants[1].id)).toBeDefined();
	});

	it("Row 13: Lost admission response with auto retry/overflow enabled", async () => {
		const fixture = await createCoordinationHarness({
			settings: {
				compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 1 },
				retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 },
			},
		});
		cleanups.push(fixture.cleanup);
		const { harness, coordinator, runtimeCoordinator, scheduler } = fixture;
		scheduler.bind(coordinator);

		const event = coordinator.seedEvent("row13-event", "ROW13_LOST_ADMIT_BODY");
		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-row13" },
		});

		const gate = coordinator.holdNextAdmission();
		const receipt = await scheduler.grant({ kind: "job", attemptId: "job-row13" });
		await gate.received;

		// Authority commits, then response is lost (rejectResponse after commit)
		gate.commit();
		await gate.committed;
		gate.rejectResponse(new Error("Lost admission RPC reply"));
		await harness.session.waitForIdle();

		// No retry, no second claim, no provider calls
		expect(harness.faux.state.callCount).toBe(0);
		expect(scheduler.inspect().grants[0]?.blockedReason).toBeDefined();

		// Explicit repair reconciles the committed admission without activating a wake run
		await harness.session.runtimeLifecycle.reconcile(runtimeCoordinator.exchange);
		await harness.session.requestAdmission.reconcile();
		await scheduler.reconcile();

		expect(harness.faux.state.callCount).toBe(0);
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "consumed" }]);
	});

	it("Row 14: Abort during held sibling tool batch; late wait result", async () => {
		const siblingEntered = Promise.withResolvers<void>();
		const siblingRelease = Promise.withResolvers<void>();

		const fixture = await createCoordinationHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "wait_tool_14",
						label: "Wait Tool 14",
						description: "waits",
						parameters: Type.Object({}),
						async execute() {
							const out = await fixture.scheduler.wait(
								{ kind: "job", attemptId: "job-row14" },
								Date.now() + 60_000,
							);
							return { content: [{ type: "text", text: `wait:${out.status}` }], details: { out } };
						},
					});
					pi.registerTool({
						name: "sibling_tool_14",
						label: "Sibling Tool 14",
						description: "held sibling",
						parameters: Type.Object({}),
						async execute() {
							siblingEntered.resolve();
							await siblingRelease.promise;
							return { content: [{ type: "text", text: "sibling:done" }], details: {} };
						},
					});
				},
			],
		});
		cleanups.push(fixture.cleanup);
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("wait_tool_14", {}, { id: "call-wait-14" }),
					fauxToolCall("sibling_tool_14", {}, { id: "call-sib-14" }),
				],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("should not run after abort during sibling tool batch"),
		]);

		const running = harness.session.prompt("run batch");
		await siblingEntered.promise;

		const aborting = harness.session.abort();
		siblingRelease.resolve();
		await Promise.all([running, aborting]);
		await harness.session.waitForIdle();

		// Late wait event arrives after abort; reconcile runtime first so refresh has a verified fence
		await harness.session.runtimeLifecycle.reconcile(fixture.runtimeCoordinator.exchange);
		const event = coordinator.seedEvent("row14-late-event", "ROW14_BODY");
		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-row14" },
		});
		await scheduler.refresh();

		expect(harness.faux.state.callCount).toBe(1);
		expect(coordinator.inspectEvent(event)?.state).toBe("pending");

		// Reopen saved SessionManager and verify both tool results are paired with the assistant's tool calls
		expectSavedToolPairing(manager.getSessionFile(), [
			{
				toolCallId: "call-wait-14",
				toolName: "wait_tool_14",
				textContains: "wait:interrupted",
				forbiddenSubstrings: ["ROW14_BODY"],
			},
			{
				toolCallId: "call-sib-14",
				toolName: "sibling_tool_14",
				textContains: "sibling:done",
				forbiddenSubstrings: ["ROW14_BODY"],
			},
		]);
	});

	it("Row 15: Direct idle session.abort with armed/claimed permissions", async () => {
		const fixture = await createCoordinationHarness();
		cleanups.push(fixture.cleanup);
		const { harness, coordinator, scheduler } = fixture;
		scheduler.bind(coordinator);

		const receipt = await scheduler.grant({ kind: "job", attemptId: "job-row15" });
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "armed" }]);

		// Direct idle session.abort() without any InteractiveMode editor
		await harness.session.abort();
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "revoked" }]);

		const event = coordinator.seedEvent("row15-event", "ROW15_BODY");
		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-row15" },
		});
		await scheduler.refresh();

		expect(harness.faux.state.callCount).toBe(0);
		expect(coordinator.inspectEvent(event)?.state).toBe("pending");
	});

	it("Row 16a: Actual session.reload in same PID", async () => {
		const fixture1 = await createCoordinationHarness();
		cleanups.push(fixture1.cleanup);
		const {
			harness: harness1,
			coordinator: coordinator1,
			manager: manager1,
			runtimeCoordinator,
			scheduler: scheduler1,
		} = fixture1;
		scheduler1.bind(coordinator1);

		const oldSchedulerRef = harness1.session.coordinationScheduler;
		const receipt1 = await oldSchedulerRef.grant({ kind: "job", attemptId: "job-row16" });

		// Perform real session.reload() in the same PID
		await harness1.session.reload();

		// Old facade is fenced/retired; new incarnation has no inherited permission
		await expect(oldSchedulerRef.grant({ kind: "job", attemptId: "job-stale" })).rejects.toThrow();
		expect(harness1.session.coordinationScheduler.inspect().grants).toEqual([]);
		expect(coordinator1.coordination.inspectGrant(receipt1.grantId)?.state).toBe("revoked");

		// Retained event on coordinator1 does not automatically wake the reloaded session
		const event = coordinator1.seedEvent("row16-event", "ROW16_BODY");
		coordinator1.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-row16" },
		});
		expect(harness1.faux.state.callCount).toBe(0);

		// Re-participate and reconcile the reloaded incarnation on the same conversation:
		// retained event recovers to the same mailbox without inheriting active permissions
		harness1.session.runtimeLifecycle.participate();
		await harness1.session.runtimeLifecycle.reconcile(runtimeCoordinator.exchange);
		expect(harness1.session.runtimeLifecycle.capture().mailboxId).toBe(fixture1.fence.mailboxId);
		harness1.session.coordinationScheduler.bind(coordinator1);
		await harness1.session.coordinationScheduler.reconcile();
		expect(harness1.faux.state.callCount).toBe(0);

		// Explicit user prompt on the reloaded session admits the retained event for its mailbox
		const freshProvider = registerFauxProvider({ api: harness1.faux.api });
		try {
			freshProvider.setResponses([fauxAssistantMessage("reloaded prompt admitted retained event")]);
			await harness1.session.prompt("prompt after reload");
			expect(freshProvider.state.callCount).toBe(1);
			expectOneAdmission(manager1, event);
		} finally {
			freshProvider.unregister();
		}
	});

	it.each(["new", "resume", "fork-before", "fork-at", "clone", "import"] as const)(
		"Row 16b (%s): Actual AgentSessionRuntime replacement in same PID fences old coordination state and routes retained events to correct mailbox",
		async (kind) => {
			const tempDir = join(tmpdir(), `pi-coord-row16b-${kind}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
			const sessionDir = join(tempDir, "sessions");
			mkdirSync(sessionDir, { recursive: true });

			const faux = registerFauxProvider({
				models: [{ id: "faux-row16b", reasoning: false }],
			});
			const authStorage = AuthStorage.inMemory();
			await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));

			const capturedContexts: ExtensionContext[] = [];
			const waitEntered = Promise.withResolvers<void>();
			let activeWaitSession: typeof runtime.session | undefined;

			const extensionFactory: ExtensionFactory = (pi: ExtensionAPI) => {
				pi.registerProvider(faux.getModel().provider, {
					baseUrl: faux.getModel().baseUrl,
					apiKey: "faux-key",
					api: faux.api,
					models: faux.models.map((m) => ({
						id: m.id,
						name: m.name,
						api: m.api,
						reasoning: m.reasoning,
						input: m.input,
						cost: m.cost,
						contextWindow: m.contextWindow,
						maxTokens: m.maxTokens,
					})),
				});
				pi.on("session_start", (_event, ctx) => {
					capturedContexts.push(ctx);
				});
				pi.registerTool({
					name: "row16b_wait",
					label: "Row 16b Wait",
					description: "waits across runtime replacement",
					parameters: Type.Object({}),
					async execute() {
						const p = activeWaitSession!.coordinationScheduler.wait(
							{ kind: "job", attemptId: `job-16b-wait-${kind}` },
							Date.now() + 60_000,
						);
						waitEntered.resolve();
						const out = await p;
						const reason = "reason" in out ? out.reason : "";
						return {
							content: [{ type: "text", text: `wait16b:${out.status}:${reason}` }],
							details: { out },
						};
					},
				});
			};

			const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
				const services = await createAgentSessionServices({
					agentDir: tempDir,
					cwd,
					resourceLoaderOptions: {
						extensionFactories: [extensionFactory],
						noSkills: true,
						noPromptTemplates: true,
						noThemes: true,
					},
				});
				const result = await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				});
				return { ...result, services, diagnostics: services.diagnostics };
			};

			const runtime = await createAgentSessionRuntime(createRuntime, {
				cwd: tempDir,
				agentDir: tempDir,
				sessionManager: SessionManager.create(tempDir, sessionDir),
			});
			runtime.setRebindSession(async (s) => {
				await s.bindExtensions({});
			});
			await runtime.session.bindExtensions({});

			cleanups.push(() => {
				void runtime.dispose();
				faux.unregister();
				if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
			});

			const authority = new FakeRuntimeCoordinator();
			const oldSession = runtime.session;
			activeWaitSession = oldSession;
			oldSession.runtimeLifecycle.participate();
			await oldSession.runtimeLifecycle.reconcile(authority.exchange);
			const oldFence = oldSession.runtimeLifecycle.capture();
			const oldCoordinator = new FakeRequestCoordinator(authority, undefined, undefined, oldFence.mailboxId);
			const oldScheduler = oldSession.coordinationScheduler;
			oldScheduler.bind(oldCoordinator);

			// 1. Admit an initial external event in Turn 1 so the saved session has admitted external history
			const admittedHistoryEvent = oldCoordinator.seedEvent(
				`row16b-admitted-${kind}`,
				"ADMITTED_HISTORY_BEFORE_REPLACEMENT",
			);
			faux.setResponses([
				fauxAssistantMessage("turn 1 admitted history reply"),
				fauxAssistantMessage(fauxToolCall("row16b_wait", {}, { id: `call-16b-${kind}` }), {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("should never run on old session after replacement"),
			]);

			await oldSession.prompt("first user turn");
			expectOneAdmission(oldSession.sessionManager, admittedHistoryEvent);
			expect(faux.state.callCount).toBe(1);

			const firstUserEntry = oldSession.sessionManager
				.getEntries()
				.find((e) => e.type === "message" && e.message.role === "user");
			expect(firstUserEntry).toBeDefined();
			const sourceFile = oldSession.sessionFile!;
			expect(sourceFile).toBeTruthy();

			// Arm a grant and start a second held grant + active wait tool on oldSession
			const oldReceipt = await oldScheduler.grant({ kind: "job", attemptId: `job-16b-armed-${kind}` });
			const heldGrantEntered = Promise.withResolvers<void>();
			const releaseHeldOldGrant = Promise.withResolvers<void>();
			const origOldGrant = oldCoordinator.grant.bind(oldCoordinator);
			vi.spyOn(oldCoordinator, "grant").mockImplementationOnce(async (op, sig) => {
				const r = await origOldGrant(op, sig);
				heldGrantEntered.resolve();
				await releaseHeldOldGrant.promise;
				return r;
			});
			const heldGrantPromise = oldScheduler.grant({ kind: "job", attemptId: `job-16b-held-${kind}` });
			await heldGrantEntered.promise;

			const oldRunPromise = oldSession.prompt("second user turn with wait");
			await waitEntered.promise;

			const secondUserEntry = oldSession.sessionManager
				.getEntries()
				.filter((e) => e.type === "message" && e.message.role === "user")
				.at(-1);
			expect(secondUserEntry).toBeDefined();

			// 2. Perform the real AgentSessionRuntime operation in the same PID while old wait + held grant are active
			let replacementResult: { cancelled: boolean };
			if (kind === "new") {
				replacementResult = await runtime.newSession();
			} else if (kind === "resume") {
				replacementResult = await runtime.switchSession(sourceFile);
			} else if (kind === "fork-before") {
				replacementResult = await runtime.fork(secondUserEntry!.id, { position: "before" });
			} else if (kind === "fork-at") {
				replacementResult = await runtime.fork(secondUserEntry!.id, { position: "at" });
			} else if (kind === "clone") {
				oldSession.sessionManager.persistNow();
				const clonedManager = SessionManager.forkFrom(sourceFile, tempDir, sessionDir);
				clonedManager.persistNow();
				replacementResult = await runtime.switchSession(clonedManager.getSessionFile()!);
			} else {
				const externalDir = join(tempDir, "external-import");
				mkdirSync(externalDir, { recursive: true });
				const externalManager = SessionManager.create(tempDir, externalDir);
				externalManager.appendMessage({
					role: "user",
					content: [{ type: "text", text: "IMPORTED_SESSION_MARKER" }],
					timestamp: Date.now(),
				});
				externalManager.persistNow();
				replacementResult = await runtime.importFromJsonl(externalManager.getSessionFile()!);
			}
			expect(replacementResult.cancelled).toBe(false);
			await oldRunPromise;

			// 3. Assert fresh instance/permission state and stale old facade/callback rejection
			releaseHeldOldGrant.resolve();
			await expect(heldGrantPromise).rejects.toThrow("Scope changed during grant");
			await expect(oldScheduler.grant({ kind: "job", attemptId: "stale-after-replace" })).rejects.toThrow();
			expect(() => capturedContexts[0]!.requestAdmission).toThrow(/stale/i);
			expect(oldSession.runtimeLifecycle.isCurrent(oldFence)).toBe(false);
			expect(oldCoordinator.coordination.inspectGrant(oldReceipt.grantId)?.state).toBe("revoked");

			// No continuation ran on oldSession (still only 2 calls: Turn 1 + Turn 2 tool call)
			expect(faux.state.callCount).toBe(2);

			// Reopen sourceFile and verify intact toolCall/toolResult pairing on old conversation
			const reopenedSource = expectSavedToolPairing(sourceFile, [
				{
					toolCallId: `call-16b-${kind}`,
					toolName: "row16b_wait",
					textContains: "wait16b:interrupted:cancelled",
					forbiddenSubstrings: ["OLD_MAILBOX_UNREAD_SECRET", "faux-key"],
				},
			]);
			expectOneAdmission(reopenedSource, admittedHistoryEvent);

			// 4. Participate, reconcile, and bind the new session
			const current = runtime.session;
			expect(current).not.toBe(oldSession);
			current.runtimeLifecycle.participate();
			await current.runtimeLifecycle.reconcile(authority.exchange);
			const currentFence = current.runtimeLifecycle.capture();
			expect(currentFence.hostId).toBe(oldFence.hostId);
			expect(currentFence.instanceId).not.toBe(oldFence.instanceId);
			expect(currentFence.incarnation).toBeGreaterThan(oldFence.incarnation);

			const sameMailbox = kind === "resume";
			if (sameMailbox) {
				expect(currentFence.mailboxId).toBe(oldFence.mailboxId);
			} else {
				expect(currentFence.mailboxId).not.toBe(oldFence.mailboxId);
			}

			// Seed a retained unread event on the OLD mailbox
			const retainedOldEvent = oldCoordinator.seedEvent(
				`row16b-retained-unread-${kind}`,
				"OLD_MAILBOX_UNREAD_SECRET",
			);
			oldCoordinator.coordination.record({
				reference: retainedOldEvent,
				recordedAt: Date.now(),
				match: { kind: "job", attemptId: `job-16b-armed-${kind}` },
			});

			const currentCoordinator = sameMailbox
				? oldCoordinator
				: new FakeRequestCoordinator(authority, undefined, undefined, currentFence.mailboxId);
			current.coordinationScheduler.bind(currentCoordinator);
			await current.requestAdmission.reconcile();
			await current.coordinationScheduler.reconcile();

			// No automatic wake call occurs after reconciliation
			expect(faux.state.callCount).toBe(2);

			// 5. Explicit prompt on the replacement session:
			// - resume (same mailbox) reads the retained unread event once and preserves admitted history
			// - fork-before/fork-at/clone (new mailbox) preserves admitted history from Turn 1 as external history record,
			//   without copying old canonical/admission records or acquiring old-mailbox unread data
			// - import (new mailbox) preserves imported history and never acquires old-mailbox unread data
			// - new (new mailbox) starts empty and never acquires old-mailbox unread data
			let capturedNewPromptContext = "";
			faux.setResponses([
				async (context) => {
					capturedNewPromptContext = JSON.stringify(context.messages);
					return fauxAssistantMessage(`reply after ${kind}`);
				},
			]);

			await current.prompt(`explicit prompt after ${kind}`);
			expect(faux.state.callCount).toBe(3);

			if (sameMailbox) {
				expect(capturedNewPromptContext).toContain("ADMITTED_HISTORY_BEFORE_REPLACEMENT");
				expect(capturedNewPromptContext).toContain("OLD_MAILBOX_UNREAD_SECRET");
				expect(oldCoordinator.inspectEvent(retainedOldEvent)?.state).toBe("read");
				const reopenedCurrent = SessionManager.open(current.sessionFile!);
				expectOneAdmission(reopenedCurrent, admittedHistoryEvent);
				expectOneAdmission(reopenedCurrent, retainedOldEvent);
			} else {
				expect(capturedNewPromptContext).not.toContain("OLD_MAILBOX_UNREAD_SECRET");
				expect(oldCoordinator.inspectEvent(retainedOldEvent)?.state).toBe("pending");
				if (kind === "fork-before" || kind === "fork-at" || kind === "clone") {
					expect(capturedNewPromptContext).toContain("ADMITTED_HISTORY_BEFORE_REPLACEMENT");
					const reopenedCurrent = SessionManager.open(current.sessionFile!);
					const externalRecords = reopenedCurrent.getEntries().flatMap((e) => {
						const r = readExternalEntry(e);
						return r ? [r] : [];
					});
					expect(externalRecords.filter((r) => r.kind === "inherited")).toHaveLength(1);
					expect(externalRecords.filter((r) => r.kind === "canonical" || r.kind === "admission")).toHaveLength(0);
				} else if (kind === "import") {
					expect(capturedNewPromptContext).toContain("IMPORTED_SESSION_MARKER");
					expect(capturedNewPromptContext).not.toContain("ADMITTED_HISTORY_BEFORE_REPLACEMENT");
				} else {
					expect(capturedNewPromptContext).not.toContain("ADMITTED_HISTORY_BEFORE_REPLACEMENT");
				}
			}
		},
	);

	it("Row 17: Disconnect/reconnect in same instance with no cancellation", async () => {
		const fixture = await createCoordinationHarness();
		cleanups.push(fixture.cleanup);
		const { harness, coordinator, manager, runtimeCoordinator, scheduler } = fixture;
		scheduler.bind(coordinator);

		const receipt = await scheduler.grant({ kind: "job", attemptId: "job-row17" });
		expect(receipt.state).toBe("armed");

		// Disconnect and reconnect in same instance without calling cancel() or abort()
		runtimeCoordinator.disconnect();
		harness.session.runtimeLifecycle.disconnect();
		runtimeCoordinator.reconnect();
		await harness.session.runtimeLifecycle.reconcile(runtimeCoordinator.exchange);

		const event = coordinator.seedEvent("row17-event", "ROW17_RETAINED_BODY");
		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-row17" },
		});

		// Reconcile recovers snapshot without automatically restoring/activating an unprompted run
		await scheduler.reconcile();
		expect(harness.faux.state.callCount).toBe(0);

		// Next user prompt can read the retained event
		harness.setResponses([fauxAssistantMessage("read after reconnect")]);
		await harness.session.prompt("prompt after reconnect");
		expect(harness.faux.state.callCount).toBe(1);
		expectOneAdmission(manager, event);
	});

	it("Row 18: New user prompt after Esc", async () => {
		const fixture = await createCoordinationHarness();
		cleanups.push(fixture.cleanup);
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		const receipt = await scheduler.grant({ kind: "job", attemptId: "job-row18" });
		const event = coordinator.seedEvent("row18-event", "ROW18_USER_READS_BODY");
		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-row18" },
		});

		scheduler.cancel();
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "revoked" }]);
		expect(harness.faux.state.callCount).toBe(0);

		harness.setResponses([fauxAssistantMessage("user read retained event after Esc")]);
		await harness.session.prompt("user prompt after Esc");

		expect(harness.faux.state.callCount).toBe(1);
		expectOneAdmission(manager, event);
		// Old permission stays revoked and never re-arms
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "revoked" }]);
	});

	it("Row 19: Explicit fresh grant after cancelled wait settles, no user prompt", async () => {
		const waitEntered = Promise.withResolvers<void>();
		const fixture = await createCoordinationHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "wait_row19",
						label: "Wait Row 19",
						description: "waits",
						parameters: Type.Object({}),
						async execute() {
							const p = fixture.scheduler.wait(
								{ kind: "job", attemptId: "job-row19-wait" },
								Date.now() + 60_000,
							);
							waitEntered.resolve();
							const out = await p;
							return { content: [{ type: "text", text: `wait:${out.status}` }], details: { out } };
						},
					});
				},
			],
		});
		cleanups.push(fixture.cleanup);
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		const oldReceipt = await scheduler.grant({ kind: "job", attemptId: "job-row19-old" });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait_row19", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("fresh grant wake response"),
		]);

		const running = harness.session.prompt("start wait to cancel");
		await waitEntered.promise;

		// Cancel wait and let run settle completely
		scheduler.cancel();
		await running;
		await harness.session.waitForIdle();
		expect(harness.faux.state.callCount).toBe(1);
		expect(scheduler.inspect().grants).toEqual([{ grantId: oldReceipt.grantId, state: "revoked" }]);

		// Issue an explicit fresh grant for an unconsumed target with NO user prompt
		const freshEvent = coordinator.seedEvent("row19-fresh-event", "ROW19_FRESH_BODY");
		coordinator.coordination.record({
			reference: freshEvent,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-row19-fresh" },
		});
		const freshReceipt = await scheduler.grant({ kind: "job", attemptId: "job-row19-fresh" });

		await vi.waitFor(() => {
			expect(harness.faux.state.callCount).toBe(2);
		});
		await harness.session.waitForIdle();

		expectOneAdmission(manager, freshEvent);
		expect(scheduler.inspect().grants).toEqual([
			{ grantId: oldReceipt.grantId, state: "revoked" },
			{ grantId: freshReceipt.grantId, state: "consumed" },
		]);
	});

	it("Control 20: Partial-success wake request (1 of 2 targets admitted, 1 blocked) emits one body-free non-transcript UI notice", async () => {
		let now = 50_000;
		const fixture = await createCoordinationHarness({ clock: () => now });
		cleanups.push(fixture.cleanup);
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		const notices: Array<{ message: string; type?: string }> = [];
		const ui = createTestUiContext({
			notify: (message, type) => {
				notices.push({ message, type });
			},
		});
		harness.session.extensionRunner.setUIContext(ui, "tui");

		const receiptGood = await scheduler.grant({ kind: "job", attemptId: "job-20-good" });
		const receiptExpiring = await scheduler.grant({ kind: "job", attemptId: "job-20-expiring" });

		const eventGood = coordinator.seedEvent("ctrl20-good", "GOOD_TARGET_SECRET_BODY");
		const eventExpiring = coordinator.seedEvent("ctrl20-expiring", "EXPIRING_TARGET_SECRET_BODY", now + 100_000);
		coordinator.coordination.record({
			reference: eventGood,
			recordedAt: now,
			match: { kind: "job", attemptId: "job-20-good" },
		});
		coordinator.coordination.record({
			reference: eventExpiring,
			recordedAt: now,
			match: { kind: "job", attemptId: "job-20-expiring" },
		});

		const gate = coordinator.holdNextAdmission();
		harness.setResponses([fauxAssistantMessage("partial wake dispatched once")]);
		await scheduler.refresh();

		await gate.received;
		// Expire the second target right before commit so commit admits 1 of 2 and returns 1 expired disposition
		now += 200_000;
		gate.commit();
		await gate.committed;
		gate.respond();

		await vi.waitFor(() => {
			expect(harness.faux.state.callCount).toBe(1);
		});
		await harness.session.waitForIdle();

		expectOneAdmission(manager, eventGood);
		expect(scheduler.inspect().grants).toEqual([
			{ grantId: receiptGood.grantId, state: "consumed" },
			{ grantId: receiptExpiring.grantId, state: "eligible", blockedReason: "expired" },
		]);

		// Partial-success wake request was NOT suppressed as a whole request, so loop request_suppressed is 0,
		// and exactly 1 body-free non-transcript UI notice was emitted by the scheduler!
		expect(harness.eventsOfType("request_suppressed")).toHaveLength(0);
		expect(notices).toHaveLength(1);
		expect(notices[0]?.message).not.toContain("GOOD_TARGET_SECRET_BODY");
		expect(notices[0]?.message).not.toContain("EXPIRING_TARGET_SECRET_BODY");

		// Subsequent refreshes do not re-wake the blocked remainder
		for (let i = 0; i < 5; i++) {
			await scheduler.refresh();
		}
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("Control 21: Setup failure during idle wake start blocks claim without unhandled rejection or stranded busy state", async () => {
		const fixture = await createCoordinationHarness();
		cleanups.push(fixture.cleanup);
		const { harness, coordinator, scheduler } = fixture;
		scheduler.bind(coordinator);

		// Inject a setup throw in _preparePromptAndToolLoadout for the idle wake start
		const sessionInternal = harness.session as unknown as {
			_preparePromptAndToolLoadout: (...args: unknown[]) => unknown;
		};
		const origPrepareLoadout = sessionInternal._preparePromptAndToolLoadout.bind(harness.session);
		vi.spyOn(sessionInternal, "_preparePromptAndToolLoadout").mockImplementationOnce(() => {
			throw new Error("Loadout preparation failed");
		});

		const event = coordinator.seedEvent("ctrl21-event", "CTRL21_SECRET_BODY");
		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-ctrl21" },
		});

		const receipt = await scheduler.grant({ kind: "job", attemptId: "job-ctrl21" });
		await vi.waitFor(() => {
			expect(scheduler.inspect().grants[0]?.blockedReason).toBe("wake-blocked");
		});
		await harness.session.waitForIdle();

		expect(harness.session.isStreaming).toBe(false);
		expect(harness.faux.state.callCount).toBe(0);
		expect(scheduler.inspect().grants).toEqual([
			{ grantId: receipt.grantId, state: "eligible", blockedReason: "wake-blocked" },
		]);
		expect(harness.eventsOfType("request_suppressed")).toMatchObject([
			{ reason: "wake-blocked", errorMessage: "Loadout preparation failed" },
		]);

		// Restore loadout preparation and verify session is not stranded busy: a user prompt works normally
		sessionInternal._preparePromptAndToolLoadout = origPrepareLoadout;
		harness.setResponses([fauxAssistantMessage("recovered user prompt")]);
		await harness.session.prompt("user prompt after setup failure");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("Control 22: Held armed grant RPC resolving after natural admission committed its consumption stays consumed while untouched armed grant remains armed", async () => {
		const fixture = await createCoordinationHarness();
		cleanups.push(fixture.cleanup);
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		const liveGrantResourceIds = new Set<number>();
		let nextGrantResourceId = 0;
		const origTrack = RuntimeIncarnation.prototype.track;
		vi.spyOn(RuntimeIncarnation.prototype, "track").mockImplementation(function (
			this: RuntimeIncarnation,
			fence,
			resource,
		) {
			const realDisposer = origTrack.call(this, fence, resource);
			if (resource.kind !== "grant") return realDisposer;
			const id = ++nextGrantResourceId;
			liveGrantResourceIds.add(id);
			let disposed = false;
			return () => {
				if (!disposed) {
					disposed = true;
					liveGrantResourceIds.delete(id);
				}
				realDisposer();
			};
		});

		const untouchedReceipt = await scheduler.grant({ kind: "job", attemptId: "job-ctrl22-untouched" });
		expect([...liveGrantResourceIds]).toEqual([1]);

		// Hold the response of the second grant RPC AFTER the authority commits the armed grant
		const grantCommittedOnAuthority = Promise.withResolvers<void>();
		const releaseGrantResponse = Promise.withResolvers<void>();
		const origGrant = coordinator.grant.bind(coordinator);
		vi.spyOn(coordinator, "grant").mockImplementationOnce(async (op, signal) => {
			const receipt = await origGrant(op, signal);
			grantCommittedOnAuthority.resolve();
			await releaseGrantResponse.promise;
			return receipt;
		});

		const heldGrantPromise = scheduler.grant({ kind: "job", attemptId: "job-ctrl22-held" });
		await grantCommittedOnAuthority.promise;
		expect([...liveGrantResourceIds]).toEqual([1, 2]);

		// While the armed grant receipt is still in flight back to the client, the event arrives
		// and a natural user prompt admits the event and consumes the grant on the authority!
		const event = coordinator.seedEvent("ctrl22-event", "CTRL22_BODY");
		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-ctrl22-held" },
		});

		harness.setResponses([fauxAssistantMessage("natural prompt consumed held grant")]);
		await harness.session.prompt("natural prompt");
		expect(harness.faux.state.callCount).toBe(1);
		expectOneAdmission(manager, event);

		// Now release the held armed receipt (which had state: "armed" and no event when created!)
		releaseGrantResponse.resolve();
		const heldReceipt = await heldGrantPromise;

		// Even though the returned receipt object was "armed" when created, local inspect records "consumed"
		// via the consumedGrantIds tombstone, and only the untouched armed grant resource ([1]) remains tracked!
		expect(scheduler.inspect().grants).toEqual([
			{ grantId: untouchedReceipt.grantId, state: "armed" },
			{ grantId: heldReceipt.grantId, state: "consumed" },
		]);
		expect([...liveGrantResourceIds]).toEqual([1]);
		expect(harness.faux.state.callCount).toBe(1);

		// Cancelling now disposes the untouched armed grant resource too
		scheduler.cancel();
		expect([...liveGrantResourceIds]).toEqual([]);
	});

	it("Control 23: Current-scope adapter.wait rejection rethrows to tool error, completes healthy natural continuation, releases wait resource, and allows subsequent fresh wake grant", async () => {
		const fixture = await createCoordinationHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "wait_reject_tool",
						label: "Wait Reject Tool",
						description: "calls scheduler.wait which rejects in current scope",
						parameters: Type.Object({}),
						async execute() {
							const out = await fixture.scheduler.wait(
								{ kind: "job", attemptId: "job-ctrl23-reject" },
								Date.now() + 60_000,
							);
							return { content: [{ type: "text", text: `unexpected:${out.status}` }], details: {} };
						},
					});
				},
			],
		});
		cleanups.push(fixture.cleanup);
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		const liveWaitResourceIds = new Set<number>();
		let nextWaitResourceId = 0;
		const origTrack = RuntimeIncarnation.prototype.track;
		vi.spyOn(RuntimeIncarnation.prototype, "track").mockImplementation(function (
			this: RuntimeIncarnation,
			fence,
			resource,
		) {
			const realDisposer = origTrack.call(this, fence, resource);
			if (resource.kind !== "wait") return realDisposer;
			const id = ++nextWaitResourceId;
			liveWaitResourceIds.add(id);
			let disposed = false;
			return () => {
				if (!disposed) {
					disposed = true;
					liveWaitResourceIds.delete(id);
				}
				realDisposer();
			};
		});

		// Reject adapter.wait in current scope without disconnecting lifecycle or pressing Esc
		vi.spyOn(coordinator, "wait").mockRejectedValueOnce(new Error("Transient wait backend failure"));

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait_reject_tool", {}, { id: "call-ctrl23-reject" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("healthy natural continuation after tool error"),
			fauxAssistantMessage("fresh wake response after failed wait run settled"),
		]);

		const fenceBefore = harness.session.runtimeLifecycle.capture();
		await harness.session.prompt("run rejecting wait tool");
		await harness.session.waitForIdle();

		// Runtime fence remained current (no disconnect, no Esc), tool error followed normal tool-error path,
		// and natural continuation completed (2 provider calls)
		expect(harness.session.runtimeLifecycle.isCurrent(fenceBefore)).toBe(true);
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.getLastAssistantText()).toBe("healthy natural continuation after tool error");

		// Saved call/result pairing has the tool error paired with call-ctrl23-reject
		expectSavedToolPairing(manager.getSessionFile(), [
			{
				toolCallId: "call-ctrl23-reject",
				toolName: "wait_reject_tool",
				textContains: "Transient wait backend failure",
			},
		]);

		// Zero active wait tickets and zero live wait resources remain after settlement
		expect(scheduler.inspect().activeWaits).toBe(0);
		expect([...liveWaitResourceIds]).toEqual([]);

		// A fresh explicit eligible grant for a different target starts 1 new permitted wake request without user prompt
		const freshEvent = coordinator.seedEvent("ctrl23-fresh-event", "CTRL23_FRESH_WAKE_BODY");
		coordinator.coordination.record({
			reference: freshEvent,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-ctrl23-fresh" },
		});
		const freshReceipt = await scheduler.grant({ kind: "job", attemptId: "job-ctrl23-fresh" });

		await vi.waitFor(() => {
			expect(harness.faux.state.callCount).toBe(3);
		});
		await harness.session.waitForIdle();

		expectOneAdmission(manager, freshEvent);
		expect(scheduler.inspect().grants).toEqual([{ grantId: freshReceipt.grantId, state: "consumed" }]);
	});
});
