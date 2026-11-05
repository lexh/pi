import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type UserMessage,
} from "@earendil-works/pi-ai/compat";
import { obj } from "@earendil-works/pi-schema";
import { describe, expect, it, vi } from "vitest";
import { Agent, type AgentEvent, type AgentTool } from "../src/index.ts";

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

type ToolCallContent = Extract<AssistantMessage["content"][number], { type: "toolCall" }>;

function createAssistantToolUseMessage(content: ToolCallContent[]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

describe("selected queue cancellation", () => {
	it.each([
		{ kind: "steering", mode: "one-at-a-time" },
		{ kind: "steering", mode: "all" },
		{ kind: "follow-up", mode: "one-at-a-time" },
		{ kind: "follow-up", mode: "all" },
		{ kind: "late", mode: "one-at-a-time" },
	] as const)("restores $kind selection in $mode mode before emission", async ({ kind, mode }) => {
		const events: AgentEvent[] = [];
		const first = createUserMessage("queued first");
		const second = createUserMessage("queued second");
		let streams = 0;
		let seeded = false;
		const agent = new Agent({
			steeringMode: mode,
			followUpMode: mode,
			prepareRequest: () => {
				if (kind === "late" && !seeded) {
					seeded = true;
					agent.steer(first);
					agent.steer(second);
					return { pollSteeringAfterPreparation: true };
				}
			},
			streamFn: () => {
				streams++;
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				return stream;
			},
		});
		agent.subscribe((event) => {
			events.push(event);
		});
		if (kind === "steering") {
			agent.steer(first);
			agent.steer(second);
		}
		if (kind === "follow-up") {
			agent.followUp(first);
			agent.followUp(second);
		}
		const queue: { drain(): UserMessage[] } = Reflect.get(
			agent,
			kind === "follow-up" ? "followUpQueue" : "steeringQueue",
		);
		const drain = queue.drain.bind(queue);
		const spy = vi.spyOn(queue, "drain").mockImplementation(() => {
			const selected = drain();
			if (selected.length > 0) queueMicrotask(() => agent.abort());
			return selected;
		});
		await agent.prompt("initial");
		spy.mockRestore();
		expect(streams).toBe(kind === "follow-up" ? 1 : 0);
		expect(events.filter((event) => event.type === "request_suppressed")).toHaveLength(1);
		expect(agent.peekQueuedMessages()).toEqual(mode === "all" ? [first, second] : [first]);
		expect(agent.state.messages).not.toContainEqual(first);
		await agent.prompt("next explicit run");
		const delivered = agent.state.messages.filter((message) => message === first || message === second);
		expect(delivered).toEqual([first, second]);
		expect(agent.hasQueuedMessages()).toBe(false);
	});
});

describe("Agent finalization", () => {
	it("forwards the finalizer and suppresses an abort during it without an assistant message", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const outcomes: string[] = [];
		let streams = 0;
		const events: AgentEvent[] = [];
		const agent = new Agent({
			finalizeRequest: async ({ context, messages }) => {
				entered.resolve();
				await release.promise;
				return {
					context,
					messages,
					assertCurrent: () => {},
					onAssistantStart: () => {},
					settle: async (outcome) => {
						outcomes.push(outcome);
					},
				};
			},
			streamFn: () => {
				streams++;
				throw new Error("unexpected stream");
			},
		});
		agent.subscribe((event) => {
			events.push(event);
		});
		const running = agent.prompt("input");
		await entered.promise;
		agent.abort();
		release.resolve();
		await running;
		expect(streams).toBe(0);
		expect(outcomes).toEqual(["cancelled-before-dispatch"]);
		expect(events.filter((event) => event.type === "request_suppressed")).toHaveLength(1);
		expect(agent.state.messages.some((message) => message.role === "assistant")).toBe(false);
		expect(agent.state.isStreaming).toBe(false);
	});
});

describe("abort after tool batch", () => {
	it("emits all sibling results before suppressing another request", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const events: AgentEvent[] = [];
		let preparations = 0;
		let streams = 0;
		const tool: AgentTool = {
			name: "held",
			label: "held",
			description: "held",
			parameters: obj({}),
			execute: async (id) => {
				if (id === "first") {
					entered.resolve();
					await release.promise;
				}
				return { content: [{ type: "text", text: id }], details: {} };
			},
		};
		const agent = new Agent({
			initialState: { tools: [tool] },
			prepareRequest: async () => {
				preparations++;
			},
			streamFn: () => {
				streams++;
				const stream = createAssistantMessageEventStream();
				stream.push({
					type: "done",
					reason: "toolUse",
					message: createAssistantToolUseMessage([
						{ type: "toolCall", id: "first", name: "held", arguments: {} },
						{ type: "toolCall", id: "second", name: "held", arguments: {} },
					]),
				});
				return stream;
			},
		});
		agent.subscribe((event) => {
			events.push(event);
		});
		const running = agent.prompt("go");
		await entered.promise;
		agent.abort();
		release.resolve();
		await running;
		expect(streams).toBe(1);
		expect(preparations).toBe(1);
		expect(
			events.flatMap((event) =>
				event.type === "message_end" && event.message.role === "toolResult" ? [event.message.toolCallId] : [],
			),
		).toEqual(["first", "second"]);
		expect(events.filter((event) => event.type === "request_suppressed")).toHaveLength(1);
	});
});
