import { randomUUID } from "node:crypto";
import type { CoordinationGate } from "./coordination-scheduler-types.ts";

export type GateEffect = { affect: "new-starts" } | { affect: "dispatch"; runId: string };

export interface ActiveGateRecord {
	id: string;
	gate: CoordinationGate;
	effect: GateEffect;
}

export class CoordinationGates {
	private readonly active = new Map<string, ActiveGateRecord>();
	private readonly dispatchWaiters = new Map<string, Set<() => void>>();

	hold(gate: CoordinationGate, effect: GateEffect): () => void {
		const id = randomUUID();
		this.active.set(id, { id, gate, effect });
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.active.delete(id);
			if (effect.affect === "dispatch") {
				const waiters = this.dispatchWaiters.get(effect.runId);
				if (waiters && !this.blocksDispatch(effect.runId)) {
					for (const wake of waiters) wake();
					this.dispatchWaiters.delete(effect.runId);
				}
			}
		};
	}

	blocksNewStarts(): boolean {
		return this.active.size > 0;
	}

	cancelRun(runId: string): void {
		const waiters = this.dispatchWaiters.get(runId);
		if (waiters) {
			for (const wake of waiters) wake();
			this.dispatchWaiters.delete(runId);
		}
	}

	blocksDispatch(runId: string): boolean {
		return [...this.active.values()].some((g) => g.effect.affect === "dispatch" && g.effect.runId === runId);
	}

	async waitForDispatch(runId: string, signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		if (!this.blocksDispatch(runId)) return;

		const barrier = Promise.withResolvers<void>();
		let waiters = this.dispatchWaiters.get(runId);
		if (!waiters) {
			waiters = new Set();
			this.dispatchWaiters.set(runId, waiters);
		}

		const onRelease = () => {
			signal?.removeEventListener("abort", onAbort);
			barrier.resolve();
		};
		const onAbort = () => {
			waiters?.delete(onRelease);
			signal?.removeEventListener("abort", onAbort);
			barrier.reject(signal?.reason ?? new Error("Aborted"));
		};

		waiters.add(onRelease);
		signal?.addEventListener("abort", onAbort, { once: true });

		return barrier.promise;
	}

	list(): CoordinationGate[] {
		return [...this.active.values()]
			.map((g) => g.gate)
			.sort((a, b) => a.kind.localeCompare(b.kind) || a.owner.localeCompare(b.owner));
	}
}
