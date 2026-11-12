import { randomUUID } from "node:crypto";
import { currentManagedCall, type ManagedCallContext, managedActivity } from "./managed-process-context.ts";
import { launchManaged } from "./managed-process-launch.ts";
import type { ManagedProcessRegistry } from "./managed-process-registry.ts";
import type {
	AcknowledgedAttemptImage,
	AttemptJournalTarget,
	ManagedChild,
	ManagedProcessAdapter,
	ManagedProcesses,
	ManagedSpawnOptions,
	ProcessSource,
	StopReceipt,
} from "./managed-process-types.ts";
import type { RuntimeFence, RuntimeLifecycle } from "./runtime-lifecycle-types.ts";
import type { BatchCertificate, FinalizationDeclaration, TaskFinalizationBook } from "./task-finalization.ts";
import { conversationKeyOf } from "./task-finalization.ts";

export interface ManagedOwnerHost {
	processes: ManagedProcessRegistry;
	taskFinalizations: TaskFinalizationBook;
	reconcileProcesses(adapter: ManagedProcessAdapter): Promise<void>;
	reconcileProcessAttempt(
		adapter: ManagedProcessAdapter,
		target: AttemptJournalTarget,
	): Promise<AcknowledgedAttemptImage>;
}

/** The ids of a helper attempt that the process authority has already reserved and capability-bound. */
export interface HelperAdmission {
	attemptId: string;
	marker: string;
}

/**
 * The authority issues ids as lower-case UUIDs. This only checks length and alphabet: the authority validates the
 * reservation itself.
 */
const RESERVED_ID = /^[a-f0-9-]{36}$/;

/**
 * Lifecycle-bound facade over the process-lifetime registry for one runtime incarnation. It allocates an attempt
 * for every claimed agent run and every standalone spawn site, and does nothing until an adapter is bound.
 */
export class ManagedProcessOwner {
	private readonly host: ManagedOwnerHost | undefined;
	private readonly lifecycle: RuntimeLifecycle;
	private readonly abortRun: (attemptId: string) => Promise<void>;
	private readonly coverage: (context: ManagedCallContext) => void;
	private adapter?: ManagedProcessAdapter;
	private participated = false;
	private retired = false;
	private activeRun?: ManagedCallContext;
	private nextHelper?: HelperAdmission;
	readonly facade: ManagedProcesses;
	constructor(
		host: ManagedOwnerHost | undefined,
		lifecycle: RuntimeLifecycle,
		abortRun: (attemptId: string) => Promise<void>,
		coverage: (context: ManagedCallContext) => void = () => {},
	) {
		this.host = host;
		this.lifecycle = lifecycle;
		this.abortRun = abortRun;
		this.coverage = coverage;
		this.facade = Object.freeze({
			captureAttemptVersion: (attemptId: string) => {
				if (!this.host) throw new Error("Managed process host unavailable");
				return this.host.processes.captureAttemptVersion(attemptId);
			},
			reconcileAttempt: (target: AttemptJournalTarget) => {
				if (!this.host || !this.adapter) return Promise.reject(new Error("Managed process adapter unavailable"));
				return this.host.reconcileProcessAttempt(this.adapter, target);
			},
			bind: (adapter: ManagedProcessAdapter) => this.bind(adapter),
			reconcile: () => this.reconcile(),
			inspect: () =>
				this.host?.processes.inspect() ?? {
					pending: 0,
					gaps: [],
					stopping: false,
					through: 0,
					reconciledThrough: 0,
				},
			requestStop: (attemptId: string, stopId: string) => this.requestStop(attemptId, stopId),
			acknowledgeStop: (receipt: StopReceipt) => this.acknowledgeStop(receipt),
			declareTaskFinalization: (declaration: FinalizationDeclaration) => this.declareFinalization(declaration),
			reconcileFinalizations: () => this.reconcileFinalizations(),
			managedSpawn: (command: string, args: readonly string[], options?: ManagedSpawnOptions) =>
				this.spawn(command, args, options),
		});
	}
	private assertActive(): void {
		if (this.retired) throw new Error("Managed process runtime retired");
	}
	/**
	 * The bound host and adapter when this runtime takes part in managed processes; undefined for ordinary pi.
	 * A runtime that never bound an adapter is unaffected by retirement. A participating one fails closed.
	 */
	private binding(): { host: ManagedOwnerHost; adapter: ManagedProcessAdapter } | undefined {
		if (!this.participated) return undefined;
		this.assertActive();
		return this.host && this.adapter ? { host: this.host, adapter: this.adapter } : undefined;
	}
	private bind(adapter: ManagedProcessAdapter): () => void {
		this.assertActive();
		if (!this.host) throw new Error("Managed process host unavailable");
		const state = this.lifecycle.inspect();
		if (
			state.state === "unavailable" ||
			!state.conversation ||
			state.state === "retired" ||
			state.state === "unregistered"
		)
			throw new Error("Managed processes require saved lifecycle participation");
		if (this.adapter) throw new Error("Managed process adapter already bound");
		this.adapter = adapter;
		this.participated = true;
		return () => {
			if (this.adapter === adapter) this.adapter = undefined;
		};
	}
	private capture(
		binding: { host: ManagedOwnerHost; adapter: ManagedProcessAdapter },
		source: ProcessSource,
		toolCallId: string,
		runId: string | null = null,
		helper?: HelperAdmission,
	): ManagedCallContext {
		const state = this.lifecycle.inspect();
		if (state.state === "unavailable" || !state.conversation || state.state === "retired")
			throw new Error("Managed runtime cannot start work");
		let fence: RuntimeFence | undefined;
		try {
			fence = this.lifecycle.capture();
		} catch {
			fence = undefined;
		}
		const attempt = binding.host.processes.begin(
			{
				operationId: randomUUID(),
				attemptId: helper?.attemptId ?? randomUUID(),
				marker: helper?.marker ?? randomUUID(),
				runId,
				provenance: {
					hostId: state.hostId,
					instanceId: state.instanceId,
					incarnation: state.incarnation,
					conversation: { ...state.conversation },
				},
			},
			fence,
			binding.adapter,
		);
		// Read by the task book when the claimed run is bound: this attempt is a helper's.
		if (helper) attempt.state.set("task-kind", "helper");
		const context = { attempt, source, toolCallId, standalone: true };
		this.coverage(context);
		return context;
	}
	/**
	 * Trusted SDK bootstrap, never part of the facade: the next claimed run becomes the attempt of a helper that the
	 * process authority has already reserved and bound. The authority validates the reservation; this refuses only
	 * what pi cannot honor, so the claim that consumes the admission never fails on the ids.
	 */
	adoptHelper(admission: HelperAdmission): void {
		this.assertActive();
		if (
			!this.host ||
			!this.adapter ||
			this.activeRun ||
			this.nextHelper ||
			!RESERVED_ID.test(admission.attemptId) ||
			!RESERVED_ID.test(admission.marker) ||
			// begin() throws on an id it has seen, and a settled run's attempt stays retained for the host's lifetime.
			this.host.processes.attempts.has(admission.attemptId)
		)
			throw new Error("Managed helper admission refused");
		this.nextHelper = { attemptId: admission.attemptId, marker: admission.marker };
	}
	/** Allocates the attempt of a claimed agent run, synchronously, before any await of the run. */
	claimRun(runId: string): ManagedCallContext | undefined {
		const binding = this.binding();
		// One claim consumes the admission, whether or not the run turns out to be managed.
		const helper = this.nextHelper;
		this.nextHelper = undefined;
		this.activeRun = binding ? this.capture(binding, "extension", runId, runId, helper) : undefined;
		if (this.activeRun) this.activeRun.standalone = false;
		return this.activeRun;
	}
	get attemptId(): string | undefined {
		return this.activeRun?.attempt.intent.attemptId;
	}
	get runContext(): ManagedCallContext | undefined {
		return this.activeRun;
	}
	/**
	 * Context for a tool hook: the enclosing scope or the claimed run. Unlike a tool call, a hook never allocates
	 * an attempt of its own, because nothing would end it.
	 */
	hookContext(toolCallId: string, source: ProcessSource): ManagedCallContext | undefined {
		if (!this.binding()) return undefined;
		const base = this.inherited() ?? this.activeRun;
		return base ? { attempt: base.attempt, source, toolCallId, standalone: false } : undefined;
	}
	/** Context for one tool execution: the hook context, or a standalone attempt that the call itself ends. */
	toolContext(toolCallId: string, source: ProcessSource): ManagedCallContext | undefined {
		const binding = this.binding();
		if (!binding) return undefined;
		return this.hookContext(toolCallId, source) ?? this.capture(binding, source, toolCallId);
	}
	settleRun(): void {
		const context = this.activeRun;
		this.activeRun = undefined;
		if (context) context.attempt.registry.end(context.attempt);
	}
	/** Runs a standalone or nested call inside a managed scope. A nested call keeps its enclosing attempt. */
	run<T>(source: ProcessSource, toolCallId: string, cancel: () => void, action: () => Promise<T>): Promise<T> {
		const binding = this.binding();
		if (!binding) return action();
		const inherited = this.inherited();
		const context = inherited ? { ...inherited, source } : this.capture(binding, source, toolCallId);
		return managedActivity(context, cancel, action).finally(() => {
			if (!inherited) context.attempt.registry.end(context.attempt);
		});
	}
	private inherited(): ManagedCallContext | undefined {
		const context = currentManagedCall();
		if (!context) return undefined;
		const state = this.lifecycle.inspect();
		if (state.state === "unavailable" || context.attempt.intent.provenance.instanceId !== state.instanceId)
			throw new Error("Managed context belongs to another runtime");
		return context;
	}
	retire(): void {
		this.retired = true;
		const state = this.lifecycle.inspect();
		if (state.state !== "unavailable") this.host?.processes.retireRuntime(state.instanceId);
		this.adapter = undefined;
	}
	private reconcile(): Promise<void> {
		// Retired facades can flush evidence, but cannot bind or launch.
		if (!this.host || !this.adapter) return Promise.resolve();
		return this.host.reconcileProcesses(this.adapter);
	}
	private requestStop(attemptId: string, stopId: string) {
		this.assertActive();
		if (!this.host) throw new Error("Managed process host unavailable");
		const target = this.host.processes.attempts.get(attemptId);
		const state = this.lifecycle.inspect();
		if (!target || state.state === "unavailable" || target.intent.provenance.instanceId !== state.instanceId)
			throw new Error("Stop belongs to another runtime");
		// Latch task finalization first: nothing a cancellation or abort callback does may still end the task as a success.
		this.host.taskFinalizations.stop(attemptId);
		return this.host.processes.requestStop(attemptId, stopId, () => this.abortRun(attemptId));
	}
	/**
	 * Sends a stop acknowledgement under the attempt's own launch fence. The attempt may belong to an earlier runtime
	 * of this process; a successor's fence is never substituted.
	 */
	private async acknowledgeStop(receipt: StopReceipt): Promise<void> {
		const target = this.host?.processes.attempts.get(receipt.attemptId);
		if (!target?.fence || !this.adapter) throw new Error("Original stop provenance is unavailable");
		await this.adapter.abortReceipt(receipt, target.fence);
	}
	private declareFinalization(declaration: FinalizationDeclaration): void {
		this.assertActive();
		const context = currentManagedCall();
		if (
			!context ||
			context.toolCallId !== declaration.declarationToolCallId ||
			context.attempt.stopping ||
			context.attempt.retired ||
			context.attempt.ended ||
			!this.host
		)
			throw new Error("Finalization requires this active managed tool call");
		const binding = this.host.taskFinalizations.current(
			conversationKeyOf(context.attempt.intent.provenance.conversation),
		);
		if (!binding || binding.attemptId !== context.attempt.intent.attemptId)
			throw new Error("Finalization belongs to another run");
		this.host.taskFinalizations.stage(binding, declaration);
	}
	/**
	 * Sends the certificate of an original, locally ended agent run. The covering COMPLETE image is drained once and
	 * its watermark frozen into the wire certificate, so every retry sends identical bytes, whatever siblings do.
	 */
	async commitFinalization(certificate: BatchCertificate): Promise<"committed" | "superseded"> {
		const target = this.host?.processes.attempts.get(certificate.attemptId);
		const adapter = this.adapter;
		if (!target || !this.host || !adapter) throw new Error("Finalization transport is unavailable");
		if (target.intent.runId !== certificate.runId || !target.ended)
			throw new Error("Certificate does not match the original ended agent run");
		type Transmission = { intent: string; target: AttemptJournalTarget; wire?: BatchCertificate };
		const state = this.host.processes.attemptState(certificate.attemptId);
		const intent = JSON.stringify(certificate);
		let transmission = state.get("finalization-transmission") as Transmission | undefined;
		if (!transmission) {
			// Captured after the ended latch, so the image that covers it includes the end.
			transmission = { intent, target: this.host.processes.captureAttemptVersion(certificate.attemptId) };
			state.set("finalization-transmission", transmission);
		}
		if (transmission.intent !== intent) throw new Error("Finalization certificate changed");
		if (!transmission.wire) {
			const covered = await this.host.reconcileProcessAttempt(adapter, transmission.target);
			// Concurrent callers freeze one wire: the first to get here wins.
			transmission.wire ??= freezeWire(certificate, covered.through);
		}
		return adapter.finalize(transmission.wire);
	}
	async reconcileFinalizations(): Promise<void> {
		if (!this.host || !this.adapter) return;
		for (const target of this.host.processes.attempts.values()) {
			if (!this.host.taskFinalizations.pending(target.intent.attemptId)) continue;
			await this.host.taskFinalizations.reconcile(target.intent.attemptId, (certificate) =>
				this.commitFinalization(certificate),
			);
		}
	}
	private spawn(command: string, args: readonly string[], options: ManagedSpawnOptions = {}): Promise<ManagedChild> {
		const controller = new AbortController();
		const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
		return this.run(
			"extension",
			randomUUID(),
			() => controller.abort(),
			async () => {
				signal.throwIfAborted();
				const launch = launchManaged(command, args, {
					cwd: options.cwd,
					env: options.env,
					stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
					shell: false,
				});
				const child = launch.child;
				const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
					child.once("error", reject);
					child.once("exit", (code, exitSignal) => resolve({ code, signal: exitSignal }));
				});
				void exited.catch(() => {});
				const abort = () => {
					launch.cancelGate();
					if (!launch.defersSignals()) child.kill("SIGTERM");
				};
				signal.addEventListener("abort", abort, { once: true });
				if (signal.aborted) abort();
				// Keep the standalone activity alive through local exit, not only handle delivery.
				const context = currentManagedCall();
				const cancelChild = () => controller.abort();
				context?.attempt.cancellations.add(cancelChild);
				const done = exited
					.then(
						() => {},
						() => {},
					)
					.finally(() => {
						signal.removeEventListener("abort", abort);
						launch.ended(signal.aborted);
						context?.attempt.activities.delete(done);
						context?.attempt.cancellations.delete(cancelChild);
					});
				context?.attempt.activities.add(done);
				await launch.registered;
				return { child, exited };
			},
		);
	}
}

/** The wire form of a certificate: a deeply frozen copy that carries the covering image's watermark. */
function freezeWire(certificate: BatchCertificate, registryThrough: number): BatchCertificate {
	const wire = { ...structuredClone(certificate), registryThrough };
	for (const result of wire.toolResults) Object.freeze(result);
	Object.freeze(wire.toolResults);
	return Object.freeze(wire);
}
