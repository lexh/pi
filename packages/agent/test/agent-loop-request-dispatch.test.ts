import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Message,
	type Model,
	normalizeContext,
	type UserMessage,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { agentLoop, agentLoopContinue, runAgentLoop } from "../src/agent-loop.ts";
import type { AgentEvent, AgentLoopConfig, AgentMessage } from "../src/types.ts";

function createUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return {
		role: "user",
		content: text,
		timestamp: Date.now(),
	};
}

// Simple identity converter for tests - just passes through standard messages
function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(m) => m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "toolResult",
	) as Message[];
}

describe("late steering after request preparation", () => {
	it.each([
		{ flag: false, initial: false, expected: [] },
		{ flag: true, initial: false, expected: ["late"] },
		{ flag: true, initial: true, expected: ["early"] },
	])(
		"polls only when requested and no earlier steering was selected: $flag/$initial",
		async ({ flag, initial, expected }) => {
			let polls = 0;
			let captured: string[] = [];
			await runAgentLoop(
				[createUserMessage("prompt")],
				{ messages: [] },
				{
					model: createModel(),
					convertToLlm: identityConverter,
					prepareRequest: () => ({ pollSteeringAfterPreparation: flag }),
					getSteeringMessages: async () => {
						polls++;
						if (polls === 1 && initial) return [createUserMessage("early")];
						if (polls === 2) return [createUserMessage("late")];
						return [];
					},
					finishTurn: () => ({ action: "end" }),
				},
				() => {},
				undefined,
				(_model, context) => {
					captured = context.messages.flatMap((message) =>
						message.role === "user" && typeof message.content === "string" ? [message.content] : [],
					);
					const stream = createAssistantMessageEventStream();
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage([]) });
					return stream;
				},
			);
			expect(captured.filter((text) => text !== "prompt")).toEqual(expected);
			expect(polls).toBe(flag && !initial ? 2 : 1);
		},
	);
});

describe("finalized request boundary", () => {
	it("finalizes normalized context after conversion and auth before dispatch", async () => {
		const order: string[] = [];
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const converted: UserMessage = { role: "user", content: "converted", timestamp: 1 };
		const replacement = normalizeContext({ messages: [{ ...converted, content: "final" }] });
		const durable = createUserMessage("durable history");
		let captured: unknown;
		let finishedMessages: AgentMessage[] = [];
		const config: AgentLoopConfig = {
			model: createModel(),
			transformContext: async (messages) => {
				order.push("transform");
				return messages;
			},
			convertToLlm: () => {
				order.push("convert");
				return [converted];
			},
			getApiKey: async () => {
				order.push("auth");
				return "key";
			},
			finishTurn: ({ context }) => {
				finishedMessages = context.messages;
			},
			finalizeRequest: async ({ messages, context }) => {
				order.push("finalize");
				expect(messages.some((message) => message.role === "user")).toBe(true);
				expect(context.messages).toContainEqual(converted);
				entered.resolve();
				await release.promise;
				return {
					context: replacement,
					messages: [durable],
					assertCurrent: () => {
						order.push("guard");
					},
					onAssistantStart: () => {
						order.push("assistant-start");
					},
					settle: async (outcome) => {
						order.push(outcome);
					},
				};
			},
		};
		const running = runAgentLoop(
			[createUserMessage("input")],
			{ messages: [] },
			config,
			() => {},
			undefined,
			(_model, context) => {
				order.push("stream");
				captured = context;
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: "stop", message: createAssistantMessage([]) });
				return stream;
			},
		);
		try {
			await Promise.race([
				entered.promise,
				running.then(() => {
					throw new Error("finalizer was not invoked");
				}),
			]);
			expect(order).toEqual(["transform", "convert", "auth", "finalize"]);
		} finally {
			release.resolve();
		}
		await running;
		expect(captured).toBe(replacement);
		expect(finishedMessages[0]).toBe(durable);
		expect(finishedMessages).toHaveLength(2);
		expect(order.indexOf("guard")).toBeGreaterThan(order.indexOf("finalize"));
		expect(order.indexOf("stream")).toBeGreaterThan(order.indexOf("guard"));
		expect(order.filter((item) => item === "stream")).toHaveLength(1);
		expect(order.filter((item) => item === "assistant-start")).toHaveLength(1);
		expect(order.filter((item) => item === "dispatch-uncertain")).toHaveLength(1);
	});
});

describe("assistant adoption", () => {
	it.each(["start", "done", "error", "result"] as const)(
		"adopts exactly once before the first %s response event",
		async (kind) => {
			const order: string[] = [];
			const config: AgentLoopConfig = {
				model: createModel(),
				convertToLlm: identityConverter,
				finalizeRequest: async ({ context, messages }) => ({
					context,
					messages,
					assertCurrent: () => {},
					onAssistantStart: () => {
						order.push("adopt");
					},
					settle: async () => {},
				}),
			};
			await runAgentLoop(
				[createUserMessage("input")],
				{ messages: [] },
				config,
				(event) => {
					if (event.type === "message_start" && event.message.role === "assistant") order.push("assistant");
				},
				undefined,
				() => {
					const stream = createAssistantMessageEventStream();
					const message = createAssistantMessage([], kind === "error" ? "error" : "stop");
					if (kind === "start") stream.push({ type: "start", partial: message });
					if (kind === "error") stream.push({ type: "error", reason: "error", error: message });
					else if (kind === "result") stream.end(message);
					else stream.push({ type: "done", reason: "stop", message });
					return stream;
				},
			);
			expect(order).toEqual(["adopt", "assistant"]);
		},
	);
});

describe("finalized payload guards", () => {
	it.each(["unchanged", "in-place", "replacement", "null"] as const)("handles %s payload", async (kind) => {
		const events: AgentEvent[] = [];
		const outcomes: string[] = [];
		let starts = 0;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			onPayload: (payload) => {
				if (kind === "in-place") (payload as { value: number }).value = 2;
				if (kind === "replacement") return { value: 2 };
				if (kind === "null") return null;
			},
			finalizeRequest: async ({ context, messages }) => ({
				context,
				messages,
				assertCurrent: () => {},
				onAssistantStart: () => {
					starts++;
				},
				settle: async (outcome) => {
					outcomes.push(outcome);
				},
			}),
		};
		await runAgentLoop(
			[createUserMessage("input")],
			{ messages: [] },
			config,
			(event) => {
				events.push(event);
			},
			undefined,
			(model, _context, options) => {
				const stream = createAssistantMessageEventStream();
				void (async () => {
					try {
						await options?.onPayload?.({ value: 1 }, model);
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage([]) });
					} catch {
						stream.push({ type: "error", reason: "error", error: createAssistantMessage([], "error") });
					}
				})();
				return stream;
			},
		);
		expect(outcomes).toEqual(["dispatch-uncertain"]);
		expect(starts).toBe(kind === "unchanged" ? 1 : 0);
		expect(events.filter((event) => event.type === "request_suppressed")).toHaveLength(kind === "unchanged" ? 0 : 1);
		expect(events.filter((event) => event.type === "message_end" && event.message.role === "assistant")).toHaveLength(
			kind === "unchanged" ? 1 : 0,
		);
	});
});

describe("guarded asynchronous payload", () => {
	it("rechecks after the payload handler and suppresses a lazy stream error", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const controller = new AbortController();
		const outcomes: string[] = [];
		const events: AgentEvent[] = [];
		let calls = 0;
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			onPayload: async () => {
				calls++;
				entered.resolve();
				await release.promise;
			},
			finalizeRequest: async ({ messages, context }) => ({
				messages,
				context,
				assertCurrent: () => {},
				onAssistantStart: () => {
					throw new Error("unexpected adoption");
				},
				settle: async (outcome) => {
					outcomes.push(outcome);
				},
			}),
		};
		const running = runAgentLoop(
			[createUserMessage("input")],
			{ messages: [] },
			config,
			(event) => {
				events.push(event);
			},
			controller.signal,
			(model, _context, options) => {
				const stream = createAssistantMessageEventStream();
				void (async () => {
					try {
						await options?.onPayload?.({ value: 1 }, model);
					} catch {
						stream.push({ type: "error", reason: "error", error: createAssistantMessage([], "error") });
					}
				})();
				return stream;
			},
		);
		await entered.promise;
		controller.abort();
		release.resolve();
		await running;
		expect(calls).toBe(1);
		expect(outcomes).toEqual(["dispatch-uncertain"]);
		expect(events.filter((event) => event.type === "request_suppressed")).toHaveLength(1);
		expect(events.filter((event) => event.type === "message_end" && event.message.role === "assistant")).toHaveLength(
			0,
		);
	});
});

describe("rejected preparation on abort", () => {
	it("suppresses an auth callback that rejects when aborted", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const controller = new AbortController();
		const events: AgentEvent[] = [];
		const running = runAgentLoop(
			[createUserMessage("input")],
			{ messages: [] },
			{
				model: createModel(),
				convertToLlm: identityConverter,
				getApiKey: async () => {
					entered.resolve();
					await release.promise;
					throw new Error("auth aborted");
				},
			},
			(event) => {
				events.push(event);
			},
			controller.signal,
			() => {
				throw new Error("unexpected stream");
			},
		);
		await entered.promise;
		controller.abort();
		release.resolve();
		await running;
		expect(events.filter((event) => event.type === "request_suppressed")).toHaveLength(1);
	});
});

describe("invoked provider cancellation", () => {
	it.each([
		{ timing: "stream-return", reason: "aborted" },
		{ timing: "first-event", reason: "aborted" },
		{ timing: "stream-return", reason: "error" },
		{ timing: "first-event", reason: "error" },
	] as const)("preserves the real unbound $reason result when abort precedes $timing", async ({ timing, reason }) => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const controller = new AbortController();
		const events: AgentEvent[] = [];
		const actual = {
			...createAssistantMessage([{ type: "text", text: "provider partial" }], reason),
			errorMessage: "provider abort detail",
		};
		let calls = 0;
		const running = runAgentLoop(
			[createUserMessage("prompt")],
			{ messages: [] },
			{ model: createModel(), convertToLlm: identityConverter },
			(event) => {
				events.push(event);
			},
			controller.signal,
			async () => {
				calls++;
				const stream = createAssistantMessageEventStream();
				entered.resolve();
				if (timing === "stream-return") {
					await release.promise;
					stream.push({ type: "error", reason, error: actual });
				} else {
					void release.promise.then(() => stream.push({ type: "error", reason, error: actual }));
				}
				return stream;
			},
		);
		await entered.promise;
		controller.abort();
		release.resolve();
		const messages = await running;
		expect(calls).toBe(1);
		expect(messages.at(-1)).toMatchObject({
			stopReason: reason,
			errorMessage: "provider abort detail",
			content: actual.content,
		});
		expect(events.filter((event) => event.type === "request_suppressed")).toHaveLength(0);
		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_end",
			"turn_end",
			"agent_end",
		]);
	});

	it.each(["stream-return", "first-event"] as const)(
		"suppresses stale finalized adoption after %s",
		async (timing) => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const controller = new AbortController();
			const events: AgentEvent[] = [];
			let adopted = 0;
			let calls = 0;
			const running = runAgentLoop(
				[createUserMessage("prompt")],
				{ messages: [] },
				{
					model: createModel(),
					convertToLlm: identityConverter,
					finalizeRequest: async ({ context, messages }) => ({
						context,
						messages,
						assertCurrent: () => {},
						onAssistantStart: () => {
							adopted++;
						},
						settle: async () => {},
					}),
				},
				(event) => {
					events.push(event);
				},
				controller.signal,
				async () => {
					calls++;
					const stream = createAssistantMessageEventStream();
					entered.resolve();
					if (timing === "stream-return") await release.promise;
					else
						void release.promise.then(() =>
							stream.push({ type: "error", reason: "aborted", error: createAssistantMessage([], "aborted") }),
						);
					if (timing === "stream-return")
						stream.push({ type: "error", reason: "aborted", error: createAssistantMessage([], "aborted") });
					return stream;
				},
			);
			await entered.promise;
			controller.abort();
			release.resolve();
			await running;
			expect(calls).toBe(1);
			expect(adopted).toBe(0);
			expect(events.filter((event) => event.type === "request_suppressed")).toHaveLength(1);
			expect(
				events.filter((event) => event.type === "message_end" && event.message.role === "assistant"),
			).toHaveLength(0);
		},
	);
});

describe("request cancellation boundaries", () => {
	it.each(["prepare", "transform", "convert", "auth", "finalize"] as const)(
		"stops after abort during %s",
		async (boundary) => {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const controller = new AbortController();
			const calls: string[] = [];
			const events: AgentEvent[] = [];
			const gate = async (name: string) => {
				calls.push(name);
				if (name === boundary) {
					entered.resolve();
					await release.promise;
				}
			};
			const config: AgentLoopConfig = {
				model: createModel(),
				prepareRequest: async () => {
					await gate("prepare");
				},
				transformContext: async (messages) => {
					await gate("transform");
					return messages;
				},
				convertToLlm: async (messages) => {
					await gate("convert");
					return identityConverter(messages);
				},
				getApiKey: async () => {
					await gate("auth");
					return undefined;
				},
				finalizeRequest: async ({ messages, context }) => {
					await gate("finalize");
					return {
						messages,
						context,
						assertCurrent: () => {},
						onAssistantStart: () => {},
						settle: async (outcome) => {
							calls.push(outcome);
						},
					};
				},
			};
			const running = runAgentLoop(
				[createUserMessage("input")],
				{ messages: [] },
				config,
				(event) => {
					events.push(event);
				},
				controller.signal,
				() => {
					calls.push("stream");
					throw new Error("unexpected dispatch");
				},
			);
			await entered.promise;
			controller.abort();
			release.resolve();
			await running;
			expect(calls).not.toContain("stream");
			expect(calls.filter((item) => ["prepare", "transform", "convert", "auth", "finalize"].includes(item))).toEqual(
				["prepare", "transform", "convert", "auth", "finalize"].slice(
					0,
					["prepare", "transform", "convert", "auth", "finalize"].indexOf(boundary) + 1,
				),
			);
			expect(calls.filter((item) => item === "cancelled-before-dispatch")).toHaveLength(
				boundary === "finalize" ? 1 : 0,
			);
			expect(events.filter((event) => event.type === "request_suppressed")).toHaveLength(1);
			expect(
				events.filter((event) => event.type === "message_end" && event.message.role === "assistant"),
			).toHaveLength(0);
		},
	);

	it.each(["prompt", "continue"] as const)(
		"settles the %s stream on suppression and rejects unclassified errors",
		async (kind) => {
			const controller = new AbortController();
			controller.abort();
			const config: AgentLoopConfig = { model: createModel(), convertToLlm: identityConverter };
			const context = { messages: [createUserMessage("existing")] };
			const make = (signal?: AbortSignal, override = config) =>
				kind === "prompt"
					? agentLoop([createUserMessage("new")], context, override, signal, () => {
							throw new Error("unexpected");
						})
					: agentLoopContinue(context, override, signal, () => {
							throw new Error("unexpected");
						});
			const unhandled: unknown[] = [];
			const onUnhandled = (error: unknown) => {
				unhandled.push(error);
			};
			process.on("unhandledRejection", onUnhandled);
			try {
				const stream = make(controller.signal);
				const events: AgentEvent[] = [];
				for await (const event of stream) events.push(event);
				await stream.result();
				expect(events.filter((event) => event.type === "request_suppressed")).toHaveLength(1);
				expect(
					events.filter((event) => event.type === "message_end" && event.message.role === "assistant"),
				).toHaveLength(0);
				const failed = make(undefined, {
					...config,
					convertToLlm: () => {
						throw new Error("converter failed");
					},
				});
				await expect(failed.result()).rejects.toThrow("converter failed");
				await new Promise<void>((resolve) => setImmediate(resolve));
				expect(unhandled).toEqual([]);
			} finally {
				process.off("unhandledRejection", onUnhandled);
			}
		},
	);
});
