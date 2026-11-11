import { randomUUID } from "node:crypto";
import type { ManagedCallContext } from "../../src/core/managed-process-context.ts";
import { ManagedProcessRegistry } from "../../src/core/managed-process-registry.ts";
import type { AttemptIntent, ManagedProcessAdapter, SpawnIntent } from "../../src/core/managed-process-types.ts";
import type { RuntimeFence } from "../../src/core/runtime-lifecycle-types.ts";

export function deferred<T>() {
	return Promise.withResolvers<T>();
}
export function fence(instanceId = "instance-one"): RuntimeFence {
	return {
		hostId: "host-one",
		instanceId,
		incarnation: 1,
		epoch: 0,
		mailboxId: "mailbox-one",
		generation: 1,
		generationToken: "private-token",
		connectionId: "connection-one",
		connectionRevision: 0,
		verificationRevision: 1,
	};
}
export function fixture(adapterOverrides: Partial<ManagedProcessAdapter> = {}) {
	const registry = new ManagedProcessRegistry();
	const intents: SpawnIntent[] = [];
	const opened: AttemptIntent[] = [];
	const adapter: ManagedProcessAdapter = {
		proveHost: async () => {},
		open: async (input) => {
			opened.push(input);
			return { attemptId: input.attemptId, marker: input.marker };
		},
		register: async (intent) => {
			intents.push(intent);
			return {
				spawnId: intent.spawnId,
				watchId: randomUUID(),
				revision: 1,
				root: { pid: intent.pid, pgid: intent.pgid, sid: intent.pid, birth: "kinfo:1000000", uniqueId: null },
			};
		},
		coverage: async () => {},
		callEnd: async () => {},
		reconcile: async (page) => ({
			acknowledgedThrough: page.complete ? page.through : page.records.at(-1)!.sequence,
			cleanup: [],
		}),
		...adapterOverrides,
	};
	const begin = (id: string = randomUUID(), instanceId = "instance-one"): ManagedCallContext => ({
		attempt: registry.begin(
			{
				operationId: `open-${id}`,
				attemptId: id,
				marker: `marker-${id}`,
				runId: null,
				provenance: {
					hostId: "host-one",
					instanceId,
					incarnation: instanceId === "instance-one" ? 1 : 2,
					conversation: { piSessionId: `conversation-${instanceId}`, sessionFile: `/saved/${instanceId}.jsonl` },
				},
			},
			fence(instanceId),
			adapter,
		),
		toolCallId: `tool-${id}`,
		source: "bash",
	});
	const intent = (context: ManagedCallContext, spawnId: string = randomUUID()): SpawnIntent => ({
		operationId: `register-${spawnId}`,
		spawnId,
		attemptId: context.attempt.intent.attemptId,
		toolCallId: context.toolCallId,
		source: context.source,
		pid: 41,
		pgid: 41,
		marker: context.attempt.intent.marker,
	});
	return { registry, adapter, begin, intent, intents, opened };
}
