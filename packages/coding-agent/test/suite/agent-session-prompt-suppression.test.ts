import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession prompt characterization", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	describe("runs started by a custom message", () => {
		it("suppresses the request when abort is requested while before_agent_start runs, then serves the next prompt", async () => {
			const handlerStarted = Promise.withResolvers<void>();
			const releaseGate = Promise.withResolvers<void>();
			let holdFirstStart = true;
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("before_agent_start", async () => {
							if (!holdFirstStart) return;
							holdFirstStart = false;
							handlerStarted.resolve();
							await releaseGate.promise;
						});
					},
				],
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("next explicit reply")]);

			const run = harness.session.sendCustomMessage(
				{ customType: "task-done", content: "background task finished", display: true },
				{ triggerTurn: true },
			);
			await handlerStarted.promise;
			const aborted = harness.session.abort();
			releaseGate.resolve();
			await Promise.all([run, aborted]);

			expect(harness.faux.state.callCount).toBe(0);
			expect(harness.eventsOfType("request_suppressed")).toMatchObject([
				{
					reason: "cancelled",
					errorMessage: "Request cancelled before an owned assistant response",
				},
			]);
			expect(harness.session.messages.some((message) => message.role === "assistant")).toBe(false);
			const last = harness.session.messages.at(-1);
			expect(last).toMatchObject({
				role: "custom",
				customType: "task-done",
			});
			expect(harness.session.isIdle).toBe(true);

			await harness.session.prompt("follow-up user request");
			expect(harness.faux.state.callCount).toBe(1);
			expect(harness.session.getLastAssistantText()).toBe("next explicit reply");
		});
	});
});
