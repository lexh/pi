import { randomUUID } from "node:crypto";
import type { ManagedCallContext } from "../../src/core/managed-process-context.ts";
import { type ManagedOwnerHost, ManagedProcessOwner } from "../../src/core/managed-process-owner.ts";
import { ManagedProcessRegistry } from "../../src/core/managed-process-registry.ts";
import type { AttemptIntent, ManagedProcessAdapter, SpawnIntent } from "../../src/core/managed-process-types.ts";
import type { RuntimeFence } from "../../src/core/runtime-lifecycle-types.ts";
import { TaskFinalizationBook } from "../../src/core/task-finalization.ts";

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
	// The host owns one book next to the registry and shares its per-attempt state.
	const taskFinalizations = new TaskFinalizationBook((id) => registry.attemptState(id));
	const intents: SpawnIntent[] = [];
	const opened: AttemptIntent[] = [];
	const adapter: ManagedProcessAdapter = {
		proveHost: async () => {},
		finalize: async () => "committed",
		abortReceipt: async () => {},
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
	const begin = (
		id: string = randomUUID(),
		instanceId = "instance-one",
		runId: string | null = null,
	): ManagedCallContext => ({
		attempt: registry.begin(
			{
				operationId: `open-${id}`,
				attemptId: id,
				marker: `marker-${id}`,
				runId,
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
	return { registry, taskFinalizations, adapter, begin, intent, intents, opened };
}

/**
 * An owner whose saved lifecycle is offline: attempts are allocated, but no fence can be captured. Its host is the
 * fixture's registry and book; `reconcileProcessAttempt` defaults to reporting the last complete image.
 */
export function offlineOwner(
	f: ReturnType<typeof fixture>,
	context: ManagedCallContext,
	options: {
		abortRun?: (attemptId: string) => Promise<void>;
		reconcileProcessAttempt?: ManagedOwnerHost["reconcileProcessAttempt"];
	} = {},
) {
	const lifecycle = {
		inspect: () => ({
			state: "pending" as const,
			hostId: "host-one",
			instanceId: "instance-one",
			incarnation: 1,
			epoch: 0,
			process: { pid: 44, birthNonce: "n" },
			conversation: context.attempt.intent.provenance.conversation,
		}),
		capture: () => {
			throw new Error("offline");
		},
		isCurrent: () => false,
		participate: () => {},
		reconcile: async () => "applied" as const,
		disconnect: () => {},
		cancel: () => {},
		track: () => () => {},
	};
	return new ManagedProcessOwner(
		{
			processes: f.registry,
			taskFinalizations: f.taskFinalizations,
			reconcileProcesses: async () => {},
			reconcileProcessAttempt:
				options.reconcileProcessAttempt ??
				(async (_adapter, target) => ({ ...target, through: f.registry.inspect().reconciledThrough })),
		},
		lifecycle,
		options.abortRun ?? (async () => {}),
	);
}
