import { AsyncLocalStorage } from "node:async_hooks";
import type { ManagedProcessRegistry } from "./managed-process-registry.ts";
import type { AttemptIntent, ManagedProcessAdapter, ProcessSource } from "./managed-process-types.ts";
import { getProcessRuntimeHost } from "./runtime-host.ts";
import type { RuntimeFence } from "./runtime-lifecycle-types.ts";

export interface ManagedAttempt {
	intent: AttemptIntent;
	fence: RuntimeFence | undefined;
	adapter: ManagedProcessAdapter;
	registry: ManagedProcessRegistry;
	stopping: boolean;
	retired: boolean;
	ended: boolean;
	opening: Promise<void>;
	activities: Set<Promise<void>>;
	cancellations: Set<() => void>;
	gates: Set<() => void>;
	stop?: { id: string; settled: Promise<void> };
	// Phase 3 stores its finalization latch/outbox here, never in extension state.
	state: Map<string, unknown>;
}
export interface ManagedCallContext {
	standalone?: boolean;
	attempt: ManagedAttempt;
	toolCallId: string;
	source: ProcessSource;
}
const ordinaryContexts = new AsyncLocalStorage<ManagedCallContext | undefined>();
function contexts(): AsyncLocalStorage<ManagedCallContext | undefined> {
	try {
		return getProcessRuntimeHost().processes.contexts;
	} catch {
		return ordinaryContexts;
	}
}
export const currentManagedCall = (): ManagedCallContext | undefined => contexts().getStore();
export function withManagedCall<T>(context: ManagedCallContext | undefined, action: () => T): T {
	return contexts().run(context, action);
}
export function managedActivity<T>(
	context: ManagedCallContext | undefined,
	cancel: () => void,
	action: () => Promise<T>,
): Promise<T> {
	if (!context) return action();
	const attempt = context.attempt;
	if (attempt.retired || attempt.stopping || attempt.ended)
		return Promise.reject(new Error("Managed attempt is closed"));
	let finish!: () => void;
	const done = new Promise<void>((resolve) => {
		finish = resolve;
	});
	attempt.activities.add(done);
	attempt.cancellations.add(cancel);
	return withManagedCall(context, () => Promise.resolve().then(action)).finally(() => {
		attempt.activities.delete(done);
		attempt.cancellations.delete(cancel);
		finish();
	});
}
