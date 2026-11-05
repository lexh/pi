import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createCoordinationHarness, expectOneAdmission } from "../helpers/coordination.ts";

describe("natural user and wake request arbitration", () => {
	it("consumes matching grant atomically on natural user request and observes local consumption", async () => {
		const fixture = await createCoordinationHarness();
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		const event = coordinator.seedEvent("job-event", "JOB_PRIVATE_BODY");
		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-a" },
		});
		const untouchedReceipt = await scheduler.grant({ kind: "job", attemptId: "job-untouched" });
		const receipt = await scheduler.grant({ kind: "job", attemptId: "job-a" });

		harness.setResponses([fauxAssistantMessage("user request response")]);

		const gate = coordinator.holdNextAdmission();
		const running = harness.session.prompt("USER_OWNS_THIS_REQUEST");

		await gate.received;
		expect(coordinator.inspectEvent(event)?.state).toBe("pending");
		expect(coordinator.coordination.inspectGrant(receipt.grantId)?.state).toBe("eligible");
		expect(coordinator.coordination.inspectGrant(untouchedReceipt.grantId)?.state).toBe("armed");

		gate.commit();
		await gate.committed;
		expect(coordinator.inspectEvent(event)?.state).toBe("read");
		expect(coordinator.coordination.inspectGrant(receipt.grantId)?.state).toBe("consumed");
		expect(coordinator.coordination.inspectGrant(untouchedReceipt.grantId)?.state).toBe("armed");
		expect(harness.faux.state.callCount).toBe(0);

		gate.respond();
		await running;
		expect(harness.faux.state.callCount).toBe(1);
		expectOneAdmission(manager, event);
		expect(scheduler.inspect().grants).toEqual([
			{ grantId: untouchedReceipt.grantId, state: "armed" },
			{ grantId: receipt.grantId, state: "consumed" },
		]);

		fixture.cleanup();
	});

	it("consumes locally armed grant when authority records eligibility before natural admission while preserving untouched armed grant", async () => {
		const fixture = await createCoordinationHarness();
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		const receipt = await scheduler.grant({ kind: "job", attemptId: "job-armed-then-eligible" });
		const untouchedReceipt = await scheduler.grant({ kind: "job", attemptId: "job-still-armed" });
		expect(receipt.state).toBe("armed");
		expect(untouchedReceipt.state).toBe("armed");

		const event = coordinator.seedEvent("job-armed-event", "ARMED_PRIVATE_BODY");
		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-armed-then-eligible" },
		});

		// Locally still armed because refresh() has not been called
		expect(scheduler.inspect().grants).toEqual([
			{ grantId: receipt.grantId, state: "armed" },
			{ grantId: untouchedReceipt.grantId, state: "armed" },
		]);

		harness.setResponses([fauxAssistantMessage("natural user response")]);
		await harness.session.prompt("USER_PROMPT_ADMITS_EVENT");

		expect(harness.faux.state.callCount).toBe(1);
		expectOneAdmission(manager, event);
		expect(scheduler.inspect().grants).toEqual([
			{ grantId: receipt.grantId, state: "consumed" },
			{ grantId: untouchedReceipt.grantId, state: "armed" },
		]);

		fixture.cleanup();
	});

	it("activates wake request while idle without fabricated user prompt", async () => {
		const fixture = await createCoordinationHarness();
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		const event = coordinator.seedEvent("job-idle-event", "IDLE_WAKE_BODY");
		const receipt = await scheduler.grant({ kind: "job", attemptId: "job-idle" });
		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-idle" },
		});

		harness.setResponses([fauxAssistantMessage("idle wake response")]);

		// Refresh triggers idle claim reconsideration
		await scheduler.refresh();

		await vi.waitFor(() => {
			expect(harness.faux.state.callCount).toBe(1);
		});

		await harness.session.waitForIdle();
		expectOneAdmission(manager, event);
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "consumed" }]);

		// No fabricated user or custom message
		const userMessages = harness.session.messages.filter((m) => m.role === "user");
		expect(userMessages).toHaveLength(1);

		fixture.cleanup();
	});

	it("continues at final-text settlement when grant becomes eligible during response", async () => {
		const fixture = await createCoordinationHarness();
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		const receipt = await scheduler.grant({ kind: "job", attemptId: "job-ft" });

		const responseGate = Promise.withResolvers<void>();
		const streamCalled = Promise.withResolvers<void>();
		harness.setResponses([
			async () => {
				streamCalled.resolve();
				await responseGate.promise;
				return fauxAssistantMessage("initial final text");
			},
			fauxAssistantMessage("continuation after final text"),
		]);

		const running = harness.session.prompt("start initial run");

		// Wait until first provider call is actually in flight
		await streamCalled.promise;

		// While first response is running, event is seeded and recorded, becoming eligible
		const event = coordinator.seedEvent("job-ft-event", "FT_WAKE_BODY");
		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-ft" },
		});
		await scheduler.refresh();

		// Release first response
		responseGate.resolve();
		await running;

		// Exactly 2 provider calls: original text + 1 target continuation
		expect(harness.faux.state.callCount).toBe(2);
		expectOneAdmission(manager, event);
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "consumed" }]);

		fixture.cleanup();
	});

	it("does not activate for ordinary mail without grant even after refresh", async () => {
		const fixture = await createCoordinationHarness();
		const { harness, coordinator, scheduler } = fixture;
		scheduler.bind(coordinator);

		coordinator.seedEvent("ordinary-unarmed-mail", "MAIL_BODY");
		await scheduler.refresh();

		// Let microtasks flush
		await new Promise((r) => setTimeout(r, 20));

		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.session.isIdle).toBe(true);

		fixture.cleanup();
	});

	it("coalesces two grants for the same target into one prompt/admission", async () => {
		const fixture = await createCoordinationHarness();
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		const event = coordinator.seedEvent("job-coalesce-event", "COALESCE_BODY");
		const g1 = await scheduler.grant({ kind: "job", attemptId: "job-coalesce" });
		const g2 = await scheduler.grant({ kind: "job", attemptId: "job-coalesce" });
		expect(g1.grantId).toBe(g2.grantId);

		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-coalesce" },
		});

		harness.setResponses([fauxAssistantMessage("coalesced response")]);
		await scheduler.refresh();

		await vi.waitFor(() => {
			expect(harness.faux.state.callCount).toBe(1);
		});
		await harness.session.waitForIdle();

		expectOneAdmission(manager, event);
		expect(scheduler.inspect().grants).toEqual([{ grantId: g1.grantId, state: "consumed" }]);

		fixture.cleanup();
	});

	it("admits two distinct eligible grants before finite snapshot in one request", async () => {
		const fixture = await createCoordinationHarness();
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		const e1 = coordinator.seedEvent("job-1-event", "BODY_1");
		const e2 = coordinator.seedEvent("job-2-event", "BODY_2");
		const g1 = await scheduler.grant({ kind: "job", attemptId: "job-1" });
		const g2 = await scheduler.grant({ kind: "job", attemptId: "job-2" });

		coordinator.coordination.record({
			reference: e1,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-1" },
		});
		coordinator.coordination.record({
			reference: e2,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-2" },
		});

		harness.setResponses([fauxAssistantMessage("two grants response")]);
		await scheduler.refresh();

		await vi.waitFor(() => {
			expect(harness.faux.state.callCount).toBe(1);
		});
		await harness.session.waitForIdle();

		expectOneAdmission(manager, e1);
		expectOneAdmission(manager, e2);
		expect(
			scheduler
				.inspect()
				.grants.map((g) => g.grantId)
				.sort(),
		).toEqual([g1.grantId, g2.grantId].sort());
		expect(scheduler.inspect().grants.every((g) => g.state === "consumed")).toBe(true);

		fixture.cleanup();
	});

	it("user preflight wins while idle claim is pending: 1 call admits target with user text", async () => {
		const fixture = await createCoordinationHarness();
		const { harness, coordinator, manager, scheduler } = fixture;
		scheduler.bind(coordinator);

		const event = coordinator.seedEvent("job-preflight-event", "PREFLIGHT_BODY");
		coordinator.coordination.record({
			reference: event,
			recordedAt: Date.now(),
			match: { kind: "job", attemptId: "job-preflight" },
		});
		// Grant and prompt synchronously so prompt preflight hold blocks the idle start
		const grantPromise = scheduler.grant({ kind: "job", attemptId: "job-preflight" });
		const promptPromise = harness.session.prompt("USER_PREFLIGHT_PROMPT");
		const receipt = await grantPromise;
		await promptPromise;

		expect(harness.faux.state.callCount).toBe(1);
		expectOneAdmission(manager, event);
		expect(scheduler.inspect().grants).toEqual([{ grantId: receipt.grantId, state: "consumed" }]);

		fixture.cleanup();
	});

	it("does not loop on unfit blocked target after repeated refreshes", async () => {
		let now = Date.now();
		const fixture = await createCoordinationHarness({ clock: () => now });
		const { harness, coordinator, scheduler } = fixture;
		scheduler.bind(coordinator);

		const event = coordinator.seedEvent("job-unfit-event", "UNFIT_BODY", now + 100000);
		coordinator.coordination.record({
			reference: event,
			recordedAt: now,
			match: { kind: "job", attemptId: "job-unfit" },
		});

		const gate = coordinator.holdNextAdmission();
		await scheduler.grant({ kind: "job", attemptId: "job-unfit" });

		// Wait until idle wake run reaches admission
		await gate.received;
		// Expire the target during commit so commit returns entries: []
		now += 200000;
		gate.commit();
		await gate.committed;
		gate.respond();

		await harness.session.waitForIdle();

		// Target failed with wake-blocked and grant is blocked
		expect(scheduler.inspect().grants[0]?.blockedReason).toBe("wake-blocked");

		// 10 subsequent refreshes must produce zero new provider calls
		const initialCount = harness.faux.state.callCount;
		for (let i = 0; i < 10; i++) {
			await scheduler.refresh();
		}

		await new Promise((r) => setTimeout(r, 20));
		expect(harness.faux.state.callCount).toBe(initialCount);

		fixture.cleanup();
	});
});
