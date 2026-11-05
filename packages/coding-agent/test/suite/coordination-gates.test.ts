import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import type { CoordinationAdmissionPolicy } from "../../src/core/coordination-scheduler-types.ts";
import { readExternalEntry } from "../../src/core/external-event-records.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "../../src/index.ts";
import { InteractiveMode } from "../../src/modes/interactive/interactive-mode.ts";
import { createCoordinationHarness, expectOneAdmission } from "../helpers/coordination.ts";
import { canonical } from "../helpers/external-events.ts";
import { createTestUiContext } from "./harness.ts";

const dummyComponent: Component = {
	render: () => ["custom-ui"],
	invalidate: () => {},
};

function hasCanonicalRecord(
	entries: ReturnType<Awaited<ReturnType<typeof createCoordinationHarness>>["manager"]["getEntries"]>,
	eventId: string,
	marker?: string,
): boolean {
	return entries.some((entry) => {
		const record = readExternalEntry(entry);
		return (
			record?.kind === "canonical" &&
			record.eventId === eventId &&
			(marker === undefined || record.envelope.includes(marker))
		);
	});
}

function hasAdmissionRecord(
	entries: ReturnType<Awaited<ReturnType<typeof createCoordinationHarness>>["manager"]["getEntries"]>,
	eventId: string,
): boolean {
	return entries.some((entry) => {
		const record = readExternalEntry(entry);
		return record?.kind === "admission" && record.eventId === eventId;
	});
}

describe("synchronous coordination gates", () => {
	it("Step 1.1: model tool calling ctx.ui.confirm acquires model permission gate and defers wake until confirmed", async () => {
		const confirmEntered = Promise.withResolvers<void>();
		const confirmGate = Promise.withResolvers<boolean>();

		const extensionFactory = (pi: ExtensionAPI) => {
			pi.registerTool({
				name: "confirm_tool",
				label: "Confirm Tool",
				description: "calls confirm",
				parameters: Type.Object({}),
				async execute(_id, _params, _signal, _onUpdate, ctx) {
					const res = await ctx.ui.confirm("Title", "Message");
					return { content: [{ type: "text", text: String(res) }], details: {} };
				},
			});
		};

		const fixture = await createCoordinationHarness({
			extensionFactories: [extensionFactory],
		});
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		const ui = createTestUiContext({
			confirm: async () => {
				confirmEntered.resolve();
				return await confirmGate.promise;
			},
		});
		harness.session.extensionRunner.setUIContext(ui, "tui");

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("confirm_tool", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done after confirm"),
		]);

		const running = harness.session.prompt("run confirm tool");
		await confirmEntered.promise;

		expect(scheduler.inspect().gates).toEqual([{ kind: "permission", owner: "model" }]);
		expect(scheduler.inspect().activeWaits).toBe(0);

		const event = coordinator.seedEvent("job-tool-confirm", "CONFIRM_TARGET_BODY");
		const receipt = await scheduler.grant({ kind: "job", attemptId: "job-confirm" });
		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-confirm" },
		});
		await scheduler.refresh();

		// While confirm is held, no second provider call or admission occurs
		expect(harness.faux.state.callCount).toBe(1);
		expect(coordinator.inspectEvent(event)?.state).toBe("pending");

		confirmGate.resolve(true);
		await running;
		await harness.session.waitForIdle();

		expect(harness.faux.state.callCount).toBe(2);
		expectOneAdmission(manager, event);
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "consumed" }]);
		expect(scheduler.inspect().gates).toEqual([]);

		fixture.cleanup();
	});

	it("Step 1.2: command context calling ctx.ui.custom acquires user utility gate and defers wake until closed", async () => {
		const customEntered = Promise.withResolvers<void>();
		const customGate = Promise.withResolvers<string>();

		const extensionFactory = (pi: ExtensionAPI) => {
			pi.registerCommand("my_cmd", {
				description: "test command",
				async handler(_args, ctx) {
					await ctx.ui.custom(() => dummyComponent);
				},
			});
		};

		const fixture = await createCoordinationHarness({
			extensionFactories: [extensionFactory],
		});
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		const ui: ExtensionUIContext = {
			...createTestUiContext(),
			custom: async <T>() => {
				customEntered.resolve();
				return (await customGate.promise) as unknown as T;
			},
		};
		harness.session.extensionRunner.setUIContext(ui, "tui");

		const cmdPromise = harness.session.prompt("/my_cmd");
		await customEntered.promise;

		expect(scheduler.inspect().gates).toEqual([{ kind: "utility", owner: "user" }]);
		expect(scheduler.inspect().activeWaits).toBe(0);

		const event = coordinator.seedEvent("job-cmd-custom", "CUSTOM_TARGET_BODY");
		const receipt = await scheduler.grant({ kind: "job", attemptId: "job-cmd" });
		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-cmd" },
		});
		await scheduler.refresh();

		expect(harness.faux.state.callCount).toBe(0);
		expect(coordinator.inspectEvent(event)?.state).toBe("pending");

		harness.setResponses([fauxAssistantMessage("wake after custom closed")]);
		customGate.resolve("done");
		await cmdPromise;

		await vi.waitFor(() => {
			expect(harness.faux.state.callCount).toBe(1);
		});
		await harness.session.waitForIdle();

		expectOneAdmission(manager, event);
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "consumed" }]);
		expect(scheduler.inspect().gates).toEqual([]);

		fixture.cleanup();
	});

	it("Step 1.3: manual session.compact holds wake, includes admitted external history, and excludes delivered unread local canonical target", async () => {
		const fixture = await createCoordinationHarness({
			settings: {
				compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 1 },
			},
		});
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		// 1. Admit an external event through real ordered admission so it is in admitted history
		const admittedEvent = coordinator.seedEvent("admitted-ext-1", "ADMITTED_EXTERNAL_HISTORY_MARKER");
		harness.setResponses([
			fauxAssistantMessage("acknowledged admitted event"),
			fauxAssistantMessage("follow-up tail response"),
		]);
		await harness.session.prompt("admit first external event");
		expectOneAdmission(manager, admittedEvent);
		await harness.session.prompt("second user turn to push first turn into summarized prefix");
		expect(harness.faux.state.callCount).toBe(2);

		// 2. Seed a private target event and deliver it into local canonical session records WITHOUT admitting it
		const unreadTarget = coordinator.seedEvent("unread-compact-target", "SECRET_DELIVERED_UNREAD_CANONICAL_BODY");
		manager.appendEntryOnce(unreadTarget, null);

		const entriesBeforeCompact = manager.getEntries();
		expect(
			hasCanonicalRecord(entriesBeforeCompact, "unread-compact-target", "SECRET_DELIVERED_UNREAD_CANONICAL_BODY"),
		).toBe(true);
		expect(hasAdmissionRecord(entriesBeforeCompact, "unread-compact-target")).toBe(false);

		const summaryEntered = Promise.withResolvers<void>();
		const summaryGate = Promise.withResolvers<void>();
		const summaryInputs: string[] = [];
		let summaryCalls = 0;
		let targetCalls = 0;

		let compacting = true;
		harness.setResponses([
			async (context) => {
				summaryCalls++;
				summaryInputs.push(JSON.stringify(context.messages));
				summaryEntered.resolve();
				await summaryGate.promise;
				return fauxAssistantMessage("neutral compaction summary");
			},
			async (context) => {
				if (compacting) {
					summaryCalls++;
					summaryInputs.push(JSON.stringify(context.messages));
					return fauxAssistantMessage("neutral turn prefix summary");
				}
				targetCalls++;
				return fauxAssistantMessage("neutral wake response");
			},
			async () => {
				targetCalls++;
				return fauxAssistantMessage("neutral wake response");
			},
		]);

		const compactPromise = harness.session.compact();
		await summaryEntered.promise;

		expect(scheduler.inspect().gates).toEqual([{ kind: "compaction", owner: "runtime" }]);

		// Record and grant the delivered unread target while compaction is held
		const receipt = await scheduler.grant({ kind: "job", attemptId: "job-manual-compact" });
		coordinator.coordination.record({
			reference: unreadTarget,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-manual-compact" },
		});
		await scheduler.refresh();

		// Target wake count remains 0 while compaction gate is held
		expect(targetCalls).toBe(0);
		expect(coordinator.inspectEvent(unreadTarget)?.state).toBe("pending");

		summaryGate.resolve();
		await compactPromise;
		compacting = false;

		const combinedSummaryInput = summaryInputs.join("\n");
		expect(combinedSummaryInput).toContain("ADMITTED_EXTERNAL_HISTORY_MARKER");
		expect(combinedSummaryInput).not.toContain("SECRET_DELIVERED_UNREAD_CANONICAL_BODY");

		await vi.waitFor(() => {
			expect(targetCalls).toBe(1);
		});
		await harness.session.waitForIdle();

		expect(summaryCalls).toBeGreaterThanOrEqual(1);
		expect(targetCalls).toBe(1);
		expectOneAdmission(manager, unreadTarget);
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "consumed" }]);
		expect(scheduler.inspect().gates).toEqual([]);

		fixture.cleanup();
	});

	it("Step 1.4: threshold automatic compaction holds wake, includes admitted external history, and excludes delivered unread local canonical target", async () => {
		const fixture = await createCoordinationHarness({
			settings: {
				compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 1 },
			},
		});
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		// 1. Admit an external event in Turn 1, then run Turn 2 so Turn 1 is in the prefix to summarize
		const admittedEvent = coordinator.seedEvent("auto-admitted-ext", "AUTO_COMPACT_ADMITTED_EXTERNAL_MARKER");
		harness.setResponses([
			fauxAssistantMessage("turn 1 admitted external"),
			fauxAssistantMessage("turn 2 assistant reply"),
		]);
		await harness.session.prompt("turn 1 prompt");
		expectOneAdmission(manager, admittedEvent);
		await harness.session.prompt("turn 2 prompt");

		// 2. Deliver unread private target into local canonical records before Turn 3 triggers threshold compaction
		const localUnreadCanonical = {
			...canonical("auto-unread-target", "AUTO_COMPACT_UNREAD_CANONICAL_SECRET"),
			recipientIdentity: fixture.fence.mailboxId,
		};
		manager.appendEntryOnce(localUnreadCanonical, null);
		expect(
			hasCanonicalRecord(manager.getEntries(), "auto-unread-target", "AUTO_COMPACT_UNREAD_CANONICAL_SECRET"),
		).toBe(true);
		expect(hasAdmissionRecord(manager.getEntries(), "auto-unread-target")).toBe(false);

		// Configure reserveTokens so projected context tokens exceed contextWindow - reserveTokens
		const contextWindow = harness.session.model!.contextWindow;
		harness.settingsManager.applyOverrides({
			compaction: { enabled: true, reserveTokens: contextWindow - 10, keepRecentTokens: 1 },
		});

		const autoSummaryEntered = Promise.withResolvers<void>();
		const autoSummaryGate = Promise.withResolvers<void>();
		const summaryInputs: string[] = [];
		let summaryCalls = 0;
		let targetCalls = 0;
		let turn3Calls = 0;

		harness.setResponses([
			async (context) => {
				summaryCalls++;
				summaryInputs.push(JSON.stringify(context.messages));
				autoSummaryEntered.resolve();
				await autoSummaryGate.promise;
				return fauxAssistantMessage("neutral auto-compaction summary");
			},
			async (context) => {
				if (harness.session.isCompacting) {
					summaryCalls++;
					summaryInputs.push(JSON.stringify(context.messages));
					return fauxAssistantMessage("neutral turn prefix summary");
				}
				turn3Calls++;
				return fauxAssistantMessage("turn 3 reply after threshold auto-compaction");
			},
			async () => {
				if (turn3Calls === 0) {
					turn3Calls++;
					return fauxAssistantMessage("turn 3 reply after threshold auto-compaction");
				}
				targetCalls++;
				return fauxAssistantMessage("neutral wake response after auto-compact");
			},
			async () => {
				targetCalls++;
				return fauxAssistantMessage("neutral wake response after auto-compact");
			},
		]);

		const promptPromise = harness.session.prompt("turn 3 triggers threshold compaction during preparation");
		await autoSummaryEntered.promise;

		expect(scheduler.inspect().gates).toEqual([{ kind: "compaction", owner: "runtime" }]);

		// Reset reserveTokens so the subsequent wake request does not re-trigger threshold compaction
		harness.settingsManager.applyOverrides({
			compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 1 },
		});

		// Seed, record, and grant the unread target while threshold auto-compaction is held
		const unreadTarget = coordinator.seedEvent("auto-unread-target", "AUTO_COMPACT_UNREAD_CANONICAL_SECRET");
		const receipt = await scheduler.grant({ kind: "job", attemptId: "job-auto-compact" });
		coordinator.coordination.record({
			reference: unreadTarget,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-auto-compact" },
		});
		await scheduler.refresh();

		expect(targetCalls).toBe(0);
		expect(coordinator.inspectEvent(unreadTarget)?.state).toBe("pending");

		autoSummaryGate.resolve();
		await promptPromise;

		const combinedSummaryInput = summaryInputs.join("\n");
		expect(combinedSummaryInput).toContain("AUTO_COMPACT_ADMITTED_EXTERNAL_MARKER");
		expect(combinedSummaryInput).not.toContain("AUTO_COMPACT_UNREAD_CANONICAL_SECRET");

		await vi.waitFor(() => {
			expect(targetCalls).toBe(1);
		});
		await harness.session.waitForIdle();

		expect(summaryCalls).toBeGreaterThanOrEqual(1);
		expect(targetCalls).toBe(1);
		expectOneAdmission(manager, unreadTarget);
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "consumed" }]);
		expect(scheduler.inspect().gates).toEqual([]);

		fixture.cleanup();
	});

	it("Step 1.5: navigateTree with summarize:true holds wake, includes admitted external history, excludes delivered unread local canonical target, and does not leak on preflight exits", async () => {
		const fixture = await createCoordinationHarness();
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		const rootLeafId = manager.getLeafId()!;

		// Preflight exit controls: same-leaf and invalid target must not leak a navigation gate
		const sameLeafResult = await harness.session.navigateTree(rootLeafId, { summarize: true });
		expect(sameLeafResult.cancelled).toBe(false);
		expect(scheduler.inspect().gates).toEqual([]);

		await expect(harness.session.navigateTree("non-existent-entry-id", { summarize: true })).rejects.toThrow(
			"Entry non-existent-entry-id not found",
		);
		expect(scheduler.inspect().gates).toEqual([]);

		// Admit external event on branch
		const admittedEvent = coordinator.seedEvent("nav-admitted-ext", "BRANCH_SUMMARY_ADMITTED_EXTERNAL_MARKER");
		harness.setResponses([fauxAssistantMessage("branch reply with admitted event")]);
		await harness.session.prompt("prompt on branch");
		expectOneAdmission(manager, admittedEvent);

		// Deliver unread private target into local canonical storage without admitting it
		const unreadTarget = coordinator.seedEvent("nav-unread-target", "BRANCH_SUMMARY_UNREAD_CANONICAL_SECRET");
		manager.appendEntryOnce(unreadTarget, null);
		expect(
			hasCanonicalRecord(manager.getEntries(), "nav-unread-target", "BRANCH_SUMMARY_UNREAD_CANONICAL_SECRET"),
		).toBe(true);
		expect(hasAdmissionRecord(manager.getEntries(), "nav-unread-target")).toBe(false);

		const navSummaryEntered = Promise.withResolvers<void>();
		const navSummaryGate = Promise.withResolvers<void>();
		let capturedNavSummaryInput = "";
		let summaryCalls = 0;
		let targetCalls = 0;

		harness.setResponses([
			async (context) => {
				summaryCalls++;
				capturedNavSummaryInput = JSON.stringify(context.messages);
				navSummaryEntered.resolve();
				await navSummaryGate.promise;
				return fauxAssistantMessage("neutral branch navigation summary");
			},
			async () => {
				targetCalls++;
				return fauxAssistantMessage("neutral wake response after navigation");
			},
		]);

		const navPromise = harness.session.navigateTree(rootLeafId, { summarize: true });
		await navSummaryEntered.promise;

		expect(scheduler.inspect().gates).toEqual([{ kind: "navigation", owner: "runtime" }]);

		const receipt = await scheduler.grant({ kind: "job", attemptId: "job-nav-summarize" });
		coordinator.coordination.record({
			reference: unreadTarget,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-nav-summarize" },
		});
		await scheduler.refresh();

		expect(targetCalls).toBe(0);
		expect(coordinator.inspectEvent(unreadTarget)?.state).toBe("pending");

		navSummaryGate.resolve();
		const navResult = await navPromise;
		expect(navResult.cancelled).toBe(false);
		expect(scheduler.inspect().gates).toEqual([]);

		expect(capturedNavSummaryInput).toContain("BRANCH_SUMMARY_ADMITTED_EXTERNAL_MARKER");
		expect(capturedNavSummaryInput).not.toContain("BRANCH_SUMMARY_UNREAD_CANONICAL_SECRET");

		await vi.waitFor(() => {
			expect(targetCalls).toBe(1);
		});
		await harness.session.waitForIdle();

		expect(summaryCalls).toBe(1);
		expect(targetCalls).toBe(1);
		expectOneAdmission(manager, unreadTarget);
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "consumed" }]);

		fixture.cleanup();
	});

	it("Step 4 & Step 5.1: maps custom blocked question/permission/auth vs overlay utility and releases nested gates out of order", async () => {
		const fixture = await createCoordinationHarness();
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		const gateQuestion = Promise.withResolvers<string>();
		const gateAuth = Promise.withResolvers<string>();
		const gateOverlay = Promise.withResolvers<string>();
		let callIndex = 0;

		const ui: ExtensionUIContext = {
			...createTestUiContext(),
			custom: async <T>() => {
				callIndex++;
				if (callIndex === 1) return (await gateQuestion.promise) as unknown as T;
				if (callIndex === 2) return (await gateAuth.promise) as unknown as T;
				return (await gateOverlay.promise) as unknown as T;
			},
		};
		harness.session.extensionRunner.setUIContext(ui, "tui");

		const cmdCtx = harness.session.extensionRunner.createCommandContext();
		const pQuestion = cmdCtx.ui.custom(() => dummyComponent, {
			blocked: { kind: "question", message: "Question?" },
		});
		const pAuth = cmdCtx.ui.custom(() => dummyComponent, {
			blocked: { kind: "auth", message: "Authenticate" },
		});
		const pOverlay = cmdCtx.ui.custom(() => dummyComponent, { overlay: true });

		expect(scheduler.inspect().gates).toEqual([
			{ kind: "auth", owner: "model" },
			{ kind: "input", owner: "model" },
			{ kind: "utility", owner: "user" },
		]);

		const event = coordinator.seedEvent("job-nested-event", "NESTED_BODY");
		const receipt = await scheduler.grant({ kind: "job", attemptId: "job-nested" });
		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-nested" },
		});
		await scheduler.refresh();
		harness.setResponses([fauxAssistantMessage("wake after all nested gates release")]);

		// Release out of order: first pQuestion, then pOverlay; pAuth still holds
		gateQuestion.resolve("q");
		await pQuestion;
		expect(scheduler.inspect().gates).toEqual([
			{ kind: "auth", owner: "model" },
			{ kind: "utility", owner: "user" },
		]);
		expect(harness.faux.state.callCount).toBe(0);

		gateOverlay.resolve("o");
		await pOverlay;
		expect(scheduler.inspect().gates).toEqual([{ kind: "auth", owner: "model" }]);
		expect(harness.faux.state.callCount).toBe(0);

		// Release final gate: wake starts once
		gateAuth.resolve("a");
		await pAuth;
		expect(scheduler.inspect().gates).toEqual([]);

		await vi.waitFor(() => {
			expect(harness.faux.state.callCount).toBe(1);
		});
		await harness.session.waitForIdle();
		expectOneAdmission(manager, event);
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "consumed" }]);

		fixture.cleanup();
	});

	it("Step 4.2: maps tool input/editor and command select/input/editor/confirm to exact gate kinds and defers wake-only start behind active-run gate", async () => {
		const observedGates: Array<ReturnType<typeof scheduler.inspect>["gates"]> = [];
		const turnEndConfirmEntered = Promise.withResolvers<void>();
		const turnEndConfirmGate = Promise.withResolvers<boolean>();

		const extensionFactory = (pi: ExtensionAPI) => {
			pi.registerTool({
				name: "dialog_tool",
				label: "Dialog Tool",
				description: "exercises input and editor",
				parameters: Type.Object({}),
				async execute(_id, _params, _signal, _onUpdate, ctx) {
					await ctx.ui.input("Input title", "placeholder");
					await ctx.ui.editor("Editor title", "prefill");
					await ctx.ui.custom(() => dummyComponent, {
						blocked: { kind: "permission", message: "Allow?" },
					});
					await ctx.ui.custom(() => dummyComponent);
					return { content: [{ type: "text", text: "dialogs done" }], details: {} };
				},
			});
			pi.on("turn_end", async (event, ctx) => {
				if (event.toolResults.length === 0) {
					await ctx.ui.confirm("Turn end confirm", "Hold wake start after final text");
				}
			});
		};

		const fixture = await createCoordinationHarness({
			extensionFactories: [extensionFactory],
		});
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		const ui: ExtensionUIContext = {
			...createTestUiContext({
				input: async () => {
					observedGates.push(scheduler.inspect().gates);
					return "typed";
				},
				editor: async () => {
					observedGates.push(scheduler.inspect().gates);
					return "edited";
				},
				confirm: async () => {
					turnEndConfirmEntered.resolve();
					return await turnEndConfirmGate.promise;
				},
			}),
			custom: async <T>() => {
				observedGates.push(scheduler.inspect().gates);
				return "custom-done" as unknown as T;
			},
		};
		harness.session.extensionRunner.setUIContext(ui, "tui");

		// Check command context input/editor -> { kind: "utility", owner: "user" }
		const cmdCtx = harness.session.extensionRunner.createCommandContext();
		await cmdCtx.ui.input("cmd input");
		await cmdCtx.ui.editor("cmd editor");
		expect(observedGates.splice(0)).toEqual([
			[{ kind: "utility", owner: "user" }],
			[{ kind: "utility", owner: "user" }],
		]);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("dialog_tool", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("final text after tool"),
			fauxAssistantMessage("wake-only request after turn_end confirm released"),
		]);

		const running = harness.session.prompt("run dialog tool");
		await turnEndConfirmEntered.promise;

		// Tool input, editor, custom(blocked: permission), custom(unblocked) mapped to exact table entries
		expect(observedGates).toEqual([
			[{ kind: "input", owner: "model" }],
			[{ kind: "input", owner: "model" }],
			[{ kind: "permission", owner: "model" }],
			[{ kind: "utility", owner: "user" }],
		]);

		// Currently held in turn_end confirm after Turn 2's final text!
		expect(scheduler.inspect().gates).toEqual([{ kind: "permission", owner: "model" }]);
		expect(harness.faux.state.callCount).toBe(2);

		// Deliver eligible wake target while turn_end confirm is held
		const event = coordinator.seedEvent("job-wake-only-after-gate", "WAKE_ONLY_GATE_BODY");
		const receipt = await scheduler.grant({ kind: "job", attemptId: "job-wake-only-after-gate" });
		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-wake-only-after-gate" },
		});
		await scheduler.refresh();

		// Wake-only request does not start while turn_end confirm is held
		expect(harness.faux.state.callCount).toBe(2);
		expect(coordinator.inspectEvent(event)?.state).toBe("pending");

		// Release turn_end confirm: wake-only request now runs at settlement (call 3)
		turnEndConfirmGate.resolve(true);
		await running;
		await harness.session.waitForIdle();

		expect(harness.faux.state.callCount).toBe(3);
		expectOneAdmission(manager, event);
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "consumed" }]);
		expect(scheduler.inspect().gates).toEqual([]);

		fixture.cleanup();
	});

	it("Step 5.2: releases gate on synchronous UI throw and on rejected custom promise", async () => {
		const fixture = await createCoordinationHarness();
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		const ui: ExtensionUIContext = {
			...createTestUiContext({
				select: () => {
					throw new Error("sync select explosion");
				},
			}),
			custom: async () => {
				throw new Error("async custom rejection");
			},
		};
		harness.session.extensionRunner.setUIContext(ui, "tui");

		const cmdCtx = harness.session.extensionRunner.createCommandContext();
		expect(() => cmdCtx.ui.select("Title", ["a"])).toThrow("sync select explosion");
		expect(scheduler.inspect().gates).toEqual([]);

		await expect(
			cmdCtx.ui.custom(() => dummyComponent, { blocked: { kind: "permission", message: "Allow?" } }),
		).rejects.toThrow("async custom rejection");
		expect(scheduler.inspect().gates).toEqual([]);

		// Subsequent granted wake still starts normally
		const event = coordinator.seedEvent("job-after-errors", "AFTER_ERR_BODY");
		const receipt = await scheduler.grant({ kind: "job", attemptId: "job-after-errors" });
		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-after-errors" },
		});
		harness.setResponses([fauxAssistantMessage("wake after ui errors")]);
		await scheduler.refresh();

		await vi.waitFor(() => {
			expect(harness.faux.state.callCount).toBe(1);
		});
		await harness.session.waitForIdle();
		expectOneAdmission(manager, event);
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "consumed" }]);

		fixture.cleanup();
	});

	it("Step 5.3: releases compaction gate on abortCompaction and allows pending wake to start", async () => {
		const beforeCompactEntered = Promise.withResolvers<void>();
		const fixture = await createCoordinationHarness({
			settings: {
				compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 1 },
			},
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						return await new Promise<{ cancel: true }>((resolve) => {
							event.signal.addEventListener("abort", () => resolve({ cancel: true }), { once: true });
							beforeCompactEntered.resolve();
						});
					});
				},
			],
		});
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		harness.setResponses([
			fauxAssistantMessage("turn 1 reply"),
			fauxAssistantMessage("turn 2 reply"),
			fauxAssistantMessage("wake after cancelled compaction"),
		]);
		await harness.session.prompt("turn 1");
		await harness.session.prompt("turn 2");

		const compactPromise = harness.session.compact();
		await beforeCompactEntered.promise;
		expect(scheduler.inspect().gates).toEqual([{ kind: "compaction", owner: "runtime" }]);

		const event = coordinator.seedEvent("job-cancel-compact", "CANCEL_COMPACT_BODY");
		const receipt = await scheduler.grant({ kind: "job", attemptId: "job-cancel-compact" });
		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-cancel-compact" },
		});
		await scheduler.refresh();

		// Wake does not start while compaction gate is held
		expect(harness.faux.state.callCount).toBe(2);

		harness.session.abortCompaction();
		await expect(compactPromise).rejects.toThrow("Compaction cancelled");
		expect(scheduler.inspect().gates).toEqual([]);

		await vi.waitFor(() => {
			expect(harness.faux.state.callCount).toBe(3);
		});
		await harness.session.waitForIdle();
		expectOneAdmission(manager, event);
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "consumed" }]);

		fixture.cleanup();
	});

	it("Step 5.4: emitToolCall permission selection via generic event context is model-owned", async () => {
		const selectEntered = Promise.withResolvers<void>();
		const selectGate = Promise.withResolvers<string | undefined>();

		const extensionFactory = (pi: ExtensionAPI) => {
			pi.registerTool({
				name: "guarded_tool",
				label: "Guarded Tool",
				description: "guarded by tool_call listener",
				parameters: Type.Object({}),
				async execute() {
					return { content: [{ type: "text", text: "executed" }], details: {} };
				},
			});
			pi.on("tool_call", async (_event, ctx) => {
				const choice = await ctx.ui.select("Allow guarded_tool?", ["allow", "deny"]);
				if (choice === "deny") {
					return { block: true, reason: "Denied by user" };
				}
				return undefined;
			});
		};

		const fixture = await createCoordinationHarness({
			extensionFactories: [extensionFactory],
		});
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		harness.session.extensionRunner.setUIContext(
			createTestUiContext({
				select: async () => {
					selectEntered.resolve();
					return await selectGate.promise;
				},
			}),
			"tui",
		);

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("guarded_tool", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("completed guarded tool"),
		]);

		const running = harness.session.prompt("invoke guarded tool");
		await selectEntered.promise;

		// Generic event context during active run is model-owned, not user utility
		expect(scheduler.inspect().gates).toEqual([{ kind: "input", owner: "model" }]);

		const event = coordinator.seedEvent("job-tool-call-perm", "TOOL_CALL_PERM_BODY");
		const receipt = await scheduler.grant({ kind: "job", attemptId: "job-tool-call-perm" });
		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-tool-call-perm" },
		});
		await scheduler.refresh();

		expect(harness.faux.state.callCount).toBe(1);

		selectGate.resolve("allow");
		await running;
		await harness.session.waitForIdle();

		expect(harness.faux.state.callCount).toBe(2);
		expectOneAdmission(manager, event);
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "consumed" }]);
		expect(scheduler.inspect().gates).toEqual([]);

		fixture.cleanup();
	});

	it("Step 5.5: shortcut opening utility UI during active run acquires user utility gate without blocking active run dispatch", async () => {
		const shortcutUiEntered = Promise.withResolvers<void>();
		const shortcutUiGate = Promise.withResolvers<string | undefined>();
		const toolEntered = Promise.withResolvers<void>();
		const toolGate = Promise.withResolvers<void>();

		const extensionFactory = (pi: ExtensionAPI) => {
			pi.registerTool({
				name: "slow_tool",
				label: "Slow Tool",
				description: "waits during run",
				parameters: Type.Object({}),
				async execute() {
					toolEntered.resolve();
					await toolGate.promise;
					return { content: [{ type: "text", text: "tool done" }], details: {} };
				},
			});
			pi.registerShortcut("ctrl+u", {
				description: "open utility ui",
				async handler(ctx) {
					await ctx.ui.select("Utility Browser", ["item-1"]);
				},
			});
		};

		const fixture = await createCoordinationHarness({
			extensionFactories: [extensionFactory],
		});
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		harness.session.extensionRunner.setUIContext(
			createTestUiContext({
				select: async () => {
					shortcutUiEntered.resolve();
					return await shortcutUiGate.promise;
				},
			}),
			"tui",
		);

		// Wire shortcut through InteractiveMode.prototype.setupExtensionShortcuts
		const fakeMode = Object.create(InteractiveMode.prototype) as {
			defaultEditor: { onExtensionShortcut?: (data: string) => boolean };
		};
		Object.assign(fakeMode, {
			runtimeHost: { session: harness.session },
			keybindings: {
				getEffectiveConfig: () => ({}),
			},
			defaultEditor: {},
			initExtensions: async () => {},
			shutdown: async () => {},
			showNewSessionConfirmation: async () => true,
			showExtensionError: () => {},
		});
		(
			InteractiveMode.prototype as unknown as {
				setupExtensionShortcuts(this: object, runner: typeof harness.session.extensionRunner): void;
			}
		).setupExtensionShortcuts.call(fakeMode, harness.session.extensionRunner);

		const shortcuts = harness.session.extensionRunner.getShortcuts({});
		const registered = shortcuts.get("ctrl+u");
		expect(registered).toBeDefined();
		const shortcutHandler = () => {
			const handled = fakeMode.defaultEditor.onExtensionShortcut?.("\x15");
			expect(handled).toBe(true);
		};

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("slow_tool", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("active run second turn dispatched while utility open"),
			fauxAssistantMessage("idle wake after utility closed"),
		]);

		const running = harness.session.prompt("start active run");
		await toolEntered.promise;

		// Trigger shortcut while active run is in slow_tool
		shortcutHandler();
		await shortcutUiEntered.promise;

		// Shortcut UI is user utility, NOT model input
		expect(scheduler.inspect().gates).toEqual([{ kind: "utility", owner: "user" }]);

		// Finish slow_tool: the active run's natural continuation dispatches WITHOUT deadlocking behind utility UI!
		toolGate.resolve();
		await running;
		expect(harness.faux.state.callCount).toBe(2);

		// Meanwhile, an idle wake target arrives while shortcut utility UI is still open
		const event = coordinator.seedEvent("job-after-shortcut", "SHORTCUT_WAKE_BODY");
		const receipt = await scheduler.grant({ kind: "job", attemptId: "job-shortcut" });
		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-shortcut" },
		});
		await scheduler.refresh();

		// Idle wake waits while utility UI remains open
		expect(harness.faux.state.callCount).toBe(2);

		// Close utility UI: idle wake now starts
		shortcutUiGate.resolve("item-1");
		await vi.waitFor(() => {
			expect(harness.faux.state.callCount).toBe(3);
		});
		await harness.session.waitForIdle();

		expectOneAdmission(manager, event);
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "consumed" }]);
		expect(scheduler.inspect().gates).toEqual([]);

		fixture.cleanup();
	});

	it("Step 5.6: rejects cached UI after run ends and after runtime replacement", async () => {
		let cachedToolCtx: ExtensionContext | undefined;
		let cachedToolUI: ExtensionContext["ui"] | undefined;

		const extensionFactory = (pi: ExtensionAPI) => {
			pi.registerTool({
				name: "cache_tool",
				label: "Cache Tool",
				description: "caches ctx and ui",
				parameters: Type.Object({}),
				async execute(_id, _params, _signal, _onUpdate, ctx) {
					cachedToolCtx = ctx;
					cachedToolUI = ctx.ui;
					return { content: [{ type: "text", text: "cached" }], details: {} };
				},
			});
		};

		const fixture = await createCoordinationHarness({
			extensionFactories: [extensionFactory],
		});
		const { harness, coordinator, scheduler } = fixture;
		scheduler.bind(coordinator);

		const cachedCmdUI = harness.session.extensionRunner.createCommandContext().ui;

		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("cache_tool", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run cache tool");
		expect(cachedToolUI).toBeDefined();
		expect(cachedToolCtx).toBeDefined();

		// Stale model run ID rejected after run ends
		await expect(cachedToolUI!.select("title", ["opt1"])).rejects.toThrow("Stale model interaction: run ID mismatch");
		await expect(cachedToolCtx!.ui.confirm("title", "msg")).rejects.toThrow(
			"Stale model interaction: run ID mismatch",
		);
		expect(scheduler.inspect().gates).toEqual([]);

		// Perform real session reload: cached command UI and cached tool UI from old runtime are rejected
		await harness.session.reload();
		expect(() => cachedCmdUI.select("title", ["opt1"])).toThrow(/stale after session replacement or reload/);
		expect(() => cachedToolUI!.select("title", ["opt1"])).toThrow(/stale after session replacement or reload/);
		expect(() => cachedToolCtx!.ui).toThrow(/stale after session replacement or reload/);
		expect(scheduler.inspect().gates).toEqual([]);

		fixture.cleanup();
	});

	it("Step 5.7: utility command awaiting ctx.waitForIdle does not hold active run dispatch or pre-settlement wake", async () => {
		const stream1Entered = Promise.withResolvers<void>();
		const stream1Gate = Promise.withResolvers<void>();
		const cmdAfterIdleEntered = Promise.withResolvers<void>();
		const cmdCustomGate = Promise.withResolvers<string>();

		const extensionFactory = (pi: ExtensionAPI) => {
			pi.registerCommand("wait_then_ui", {
				description: "waits for idle then opens utility ui",
				async handler(_args, ctx) {
					await ctx.waitForIdle();
					await ctx.ui.custom(() => dummyComponent);
				},
			});
		};

		const fixture = await createCoordinationHarness({
			extensionFactories: [extensionFactory],
		});
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		await harness.session.bindExtensions({
			uiContext: {
				...createTestUiContext(),
				custom: async <T>() => {
					cmdAfterIdleEntered.resolve();
					return (await cmdCustomGate.promise) as unknown as T;
				},
			},
			commandContextActions: {
				waitForIdle: () => harness.session.waitForIdle(),
				newSession: async () => ({ cancelled: false }),
				fork: async () => ({ cancelled: false }),
				navigateTree: async () => ({ cancelled: false }),
				switchSession: async () => ({ cancelled: false }),
				reload: async () => {},
			},
		});

		harness.setResponses([
			async () => {
				stream1Entered.resolve();
				await stream1Gate.promise;
				return fauxAssistantMessage("turn 1 final text");
			},
			fauxAssistantMessage("pre-settlement wake continuation"),
		]);

		const running = harness.session.prompt("start turn 1");
		await stream1Entered.promise;

		// User preflight hold was already released when run was claimed
		expect(scheduler.inspect().gates).toEqual([]);

		// Invoke /wait_then_ui while Turn 1 is active
		const cmdPromise = harness.session.prompt("/wait_then_ui");

		// Recognizing the command released its preflight hold before awaiting ctx.waitForIdle()
		expect(scheduler.inspect().gates).toEqual([]);

		// Deliver an eligible wake target during Turn 1 final text
		const event1 = coordinator.seedEvent("job-during-wait-idle", "WAKE_DURING_RUN_BODY");
		const receipt1 = await scheduler.grant({ kind: "job", attemptId: "job-during-wait-idle" });
		coordinator.coordination.record({
			reference: event1,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-during-wait-idle" },
		});
		await scheduler.refresh();

		// Release Turn 1: pre-settlement wake continuation runs and settles naturally without deadlocking!
		stream1Gate.resolve();
		await running;
		expect(harness.faux.state.callCount).toBe(2);
		expectOneAdmission(manager, event1);
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt1.grantId, state: "consumed" }]);

		// Now that the run settled, /wait_then_ui resumed and opened its custom utility UI
		await cmdAfterIdleEntered.promise;
		expect(scheduler.inspect().gates).toEqual([{ kind: "utility", owner: "user" }]);

		cmdCustomGate.resolve("done");
		await cmdPromise;
		expect(scheduler.inspect().gates).toEqual([]);

		fixture.cleanup();
	});

	it("Addendum 2: unwinds wake request cancelled during held pre-dispatch without waiting for UI release", async () => {
		const stream1Entered = Promise.withResolvers<void>();
		const stream1Gate = Promise.withResolvers<void>();
		const wakePrepareConfirmEntered = Promise.withResolvers<void>();
		const wakePrepareConfirmGate = Promise.withResolvers<boolean>();
		let confirmPromise: Promise<boolean> | undefined;
		let contextEventCount = 0;

		const extensionFactory = (pi: ExtensionAPI) => {
			pi.on("context", async (_event, ctx) => {
				contextEventCount++;
				if (contextEventCount === 2) {
					// Second request is the wake continuation: open a model permission hold during prepare
					// without awaiting it inside `context` so finalize reaches `beforeFinalize` and blocks on the gate!
					confirmPromise = ctx.ui.confirm("Hold wake finalize", "Wait before finalize");
				}
			});
		};

		const fixture = await createCoordinationHarness({
			extensionFactories: [extensionFactory],
		});
		const { harness, coordinator, scheduler } = fixture;
		scheduler.bind(coordinator);

		const policy = scheduler as unknown as CoordinationAdmissionPolicy;
		const beforeFinalizeReached = Promise.withResolvers<void>();
		let beforeFinalizeCalls = 0;
		const origBeforeFinalize = policy.beforeFinalize.bind(policy);
		vi.spyOn(policy, "beforeFinalize").mockImplementation(async (signal?: AbortSignal) => {
			beforeFinalizeCalls++;
			if (beforeFinalizeCalls === 2) {
				beforeFinalizeReached.resolve();
			}
			return await origBeforeFinalize(signal);
		});
		const workspaceSpy = vi.spyOn(coordinator, "workspace");
		const admitSpy = vi.spyOn(coordinator, "admit");

		harness.session.extensionRunner.setUIContext(
			createTestUiContext({
				confirm: async () => {
					wakePrepareConfirmEntered.resolve();
					return await wakePrepareConfirmGate.promise;
				},
			}),
			"tui",
		);

		harness.setResponses([
			async () => {
				stream1Entered.resolve();
				await stream1Gate.promise;
				return fauxAssistantMessage("turn 1 final text");
			},
			fauxAssistantMessage("turn 2 wake should never dispatch"),
		]);

		const running = harness.session.prompt("start turn 1");
		await stream1Entered.promise;

		// Record and grant target ONLY after Turn 1 stream entry so Turn 1 did not consume it
		const event = coordinator.seedEvent("job-cancel-held-event", "CANCEL_HELD_BODY");
		const receipt = await scheduler.grant({ kind: "job", attemptId: "job-cancel-held" });
		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-cancel-held" },
		});
		await scheduler.refresh();

		expect(coordinator.inspectEvent(event)?.state).toBe("pending");
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "eligible" }]);

		// Release Turn 1: Turn 1 finishes final text, claims the wake target, and enters wake beforeFinalize
		stream1Gate.resolve();
		await wakePrepareConfirmEntered.promise;
		await beforeFinalizeReached.promise;

		// The wake continuation is now held at beforeFinalize behind the model permission gate!
		expect(contextEventCount).toBe(2);
		expect(beforeFinalizeCalls).toBe(2);
		expect(workspaceSpy).toHaveBeenCalledTimes(1);
		expect(admitSpy).toHaveBeenCalledTimes(0);
		expect(scheduler.inspect().gates).toEqual([{ kind: "permission", owner: "model" }]);
		expect(harness.faux.state.callCount).toBe(1);
		expect(coordinator.inspectEvent(event)?.state).toBe("pending");

		// Cancel coordination while wake is held at beforeFinalize, WITHOUT releasing wakePrepareConfirmGate!
		scheduler.cancel();

		// The run unwinds and settles without waiting for wakePrepareConfirmGate to resolve,
		// while the still-open UI hold itself remains recorded until the UI closes!
		await running;
		await harness.session.waitForIdle();

		expect(workspaceSpy).toHaveBeenCalledTimes(1);
		expect(admitSpy).toHaveBeenCalledTimes(0);
		expect(harness.faux.state.callCount).toBe(1);
		expect(coordinator.inspectEvent(event)?.state).toBe("pending");
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "revoked" }]);
		expect(scheduler.inspect().gates).toEqual([{ kind: "permission", owner: "model" }]);

		// Now release the held UI callback and verify gates become empty and no late prepare/admit/stream/provider call occurs
		wakePrepareConfirmGate.resolve(true);
		await confirmPromise;
		await scheduler.refresh();
		expect(scheduler.inspect().gates).toEqual([]);
		expect(contextEventCount).toBe(2);
		expect(workspaceSpy).toHaveBeenCalledTimes(1);
		expect(admitSpy).toHaveBeenCalledTimes(0);
		expect(harness.faux.state.callCount).toBe(1);
		expect(coordinator.inspectEvent(event)?.state).toBe("pending");

		fixture.cleanup();
	});

	it("Natural vs Wake Gate Control: permission-only scheduler.cancel keeps natural request blocked behind model UI gate until UI release", async () => {
		const confirmEntered = Promise.withResolvers<void>();
		const confirmGate = Promise.withResolvers<boolean>();
		let confirmPromise: Promise<boolean> | undefined;

		const extensionFactory = (pi: ExtensionAPI) => {
			pi.on("context", async (_event, ctx) => {
				// Fire-and-forget model UI interaction during natural request preparation
				// so the request reaches beforeFinalize and blocks on the model permission gate
				confirmPromise = ctx.ui.confirm("Natural request gate", "Hold natural request at beforeFinalize");
			});
		};

		const fixture = await createCoordinationHarness({
			extensionFactories: [extensionFactory],
		});
		const { harness, coordinator, scheduler } = fixture;
		scheduler.bind(coordinator);

		const policy = scheduler as unknown as CoordinationAdmissionPolicy;
		const beforeFinalizeReached = Promise.withResolvers<void>();
		const origBeforeFinalize = policy.beforeFinalize.bind(policy);
		vi.spyOn(policy, "beforeFinalize").mockImplementation(async (signal?: AbortSignal) => {
			beforeFinalizeReached.resolve();
			return await origBeforeFinalize(signal);
		});
		const workspaceSpy = vi.spyOn(coordinator, "workspace");

		harness.session.extensionRunner.setUIContext(
			createTestUiContext({
				confirm: async () => {
					confirmEntered.resolve();
					return await confirmGate.promise;
				},
			}),
			"tui",
		);

		// Arm an unrelated wake grant
		const unrelatedReceipt = await scheduler.grant({ kind: "job", attemptId: "job-unrelated-armed" });
		expect(scheduler.inspect().grants).toEqual([{ grantId: unrelatedReceipt.grantId, state: "armed" }]);

		let capturedPromptText = "";
		harness.setResponses([
			async (context) => {
				capturedPromptText = JSON.stringify(context.messages);
				return fauxAssistantMessage("natural user response after UI release");
			},
		]);

		const running = harness.session.prompt("NATURAL_USER_HELD_BY_GATE");
		await confirmEntered.promise;
		await beforeFinalizeReached.promise;

		// 1. Prove natural dispatch waiter reached beforeFinalize and post-gate workspace/provider are still zero
		expect(workspaceSpy).toHaveBeenCalledTimes(0);
		expect(harness.faux.state.callCount).toBe(0);
		expect(scheduler.inspect().gates).toEqual([{ kind: "permission", owner: "model" }]);

		// 2. Call scheduler.cancel() ONLY (overlay-equivalent), not session.abort()
		scheduler.cancel();

		// 3. Unrelated grant is revoked, but natural request MUST remain blocked while model UI is held
		expect(scheduler.inspect().grants).toEqual([{ grantId: unrelatedReceipt.grantId, state: "revoked" }]);
		expect(scheduler.inspect().gates).toEqual([{ kind: "permission", owner: "model" }]);

		// Flush microtasks / coordinator refresh and verify natural request did NOT bypass its model gate
		await scheduler.refresh();
		expect(workspaceSpy).toHaveBeenCalledTimes(0);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.eventsOfType("request_suppressed")).toEqual([]);

		// 4. Release the UI: the original natural request now proceeds past beforeFinalize and makes exactly 1 call
		confirmGate.resolve(true);
		await confirmPromise;
		await running;
		await harness.session.waitForIdle();

		expect(workspaceSpy).toHaveBeenCalledTimes(1);
		expect(harness.faux.state.callCount).toBe(1);
		expect(capturedPromptText).toContain("NATURAL_USER_HELD_BY_GATE");
		expect(harness.eventsOfType("request_suppressed")).toEqual([]);
		expect(scheduler.inspect().gates).toEqual([]);

		fixture.cleanup();
	});
});
