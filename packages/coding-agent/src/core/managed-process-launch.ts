import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readLocalProcessBirth } from "./managed-process-birth.ts";
import { currentManagedCall } from "./managed-process-context.ts";
import { spawnGate } from "./managed-process-gate.ts";
import type { ProcessJournalEntry } from "./managed-process-types.ts";

/** A spawned child plus the controls a spawn site needs to honor registration and service stop. */
export interface ManagedLaunch {
	child: ChildProcess;
	/** Settles once the gate has been released or cancelled, not when the child exits. */
	registered: Promise<void>;
	/** Closes an unreleased gate; the gate shell then exits 125 without running the command. */
	cancelGate(): void;
	/** True once a service stop owns termination: pi must send no OS signal of its own. */
	defersSignals(): boolean;
	/** Reports that the spawning call finished. */
	ended(aborted: boolean): void;
}

/**
 * Spawn a command. Outside a participating macOS attempt this is plain `spawn`. Inside one, the command waits
 * on the fd gate until registration is acknowledged, a bounded outage retained as a coverage gap, or cancellation.
 */
export function launchManaged(command: string, args: readonly string[], options: SpawnOptions): ManagedLaunch {
	const context = currentManagedCall();
	if (!context || process.platform !== "darwin") {
		return {
			child: spawn(command, [...args], options),
			registered: Promise.resolve(),
			cancelGate: () => {},
			defersSignals: () => false,
			ended: () => {},
		};
	}
	const { attempt } = context;
	if (attempt.stopping || attempt.retired || attempt.ended) throw new Error("Managed attempt is closed");
	const gate = spawnGate(command, args, {
		...options,
		env: { ...(options.env ?? process.env), GOETIA_ATTEMPT_MARKER: attempt.intent.marker },
	});
	const child = gate.child;
	const cancel = () => gate.cancel();
	attempt.gates.add(cancel);
	let cancelled = false;
	const cancelGate = () => {
		cancelled = true;
		gate.cancel();
	};
	let entry: ProcessJournalEntry | undefined;
	try {
		if (child.pid) {
			const localBirth = readLocalProcessBirth(child.pid);
			entry = attempt.registry.record(
				{
					operationId: randomUUID(),
					spawnId: randomUUID(),
					attemptId: attempt.intent.attemptId,
					toolCallId: context.toolCallId,
					source: context.source,
					pid: child.pid,
					pgid: child.pid,
					marker: attempt.intent.marker,
				},
				context,
				localBirth,
			);
			if (!localBirth && entry) attempt.registry.spawnGap(entry, context, "identity-unverifiable");
		}
	} catch (error) {
		cancelGate();
		attempt.gates.delete(cancel);
		throw error;
	}
	const handshake = async () => {
		if (!entry || !child.pid) {
			if (child.pid && !cancelled && !attempt.stopping && !attempt.retired) gate.release();
			else gate.cancel();
			return;
		}
		const recorded = entry;
		let acknowledged = false;
		let refused = false;
		const registration = attempt.opening
			.then(async () => {
				if (!attempt.fence) throw new Error("No captured attachment");
				const receipt = await attempt.adapter.register(recorded.intent, attempt.fence);
				attempt.registry.registered(receipt, recorded);
				acknowledged = true;
			})
			.catch((error: unknown) => {
				// Wire error codes are a trust boundary; only explicit refusals cancel ordinary work.
				const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
				refused = [
					"attempt-stopping",
					"stale-instance",
					"stale-fence",
					"host-auth-refused",
					"invalid-receipt",
					"wrong-binding",
					"forbidden",
					"operation-conflict",
					"attempt-finalized",
				].includes(code);
			});
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				registration,
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, 1000);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
		if (cancelled || attempt.stopping || attempt.retired || attempt.ended || refused) {
			gate.cancel();
			return;
		}
		if (!acknowledged) attempt.registry.spawnGap(recorded, context, "registration-outage");
		attempt.registry.released(recorded);
		gate.release();
	};
	const registered = handshake().catch((error: unknown) => {
		gate.cancel();
		throw error;
	});
	void registered.catch(() => {});
	return {
		child,
		registered,
		cancelGate,
		defersSignals: () => attempt.stopping,
		ended: (aborted: boolean) => {
			attempt.gates.delete(cancel);
			attempt.registry.callEnded(entry, context, aborted);
		},
	};
}
