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
} from "./managed-process-types.ts";
import type { RuntimeFence, RuntimeLifecycle } from "./runtime-lifecycle-types.ts";

export interface ManagedOwnerHost {
	processes: ManagedProcessRegistry;
	reconcileProcesses(adapter: ManagedProcessAdapter): Promise<void>;
	reconcileProcessAttempt(
		adapter: ManagedProcessAdapter,
		target: AttemptJournalTarget,
	): Promise<AcknowledgedAttemptImage>;
}

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
				attemptId: randomUUID(),
				marker: randomUUID(),
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
		const context = { attempt, source, toolCallId, standalone: true };
		this.coverage(context);
		return context;
	}
	/** Allocates the attempt of a claimed agent run, synchronously, before any await of the run. */
	claimRun(runId: string): ManagedCallContext | undefined {
		const binding = this.binding();
		this.activeRun = binding ? this.capture(binding, "extension", runId, runId) : undefined;
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
		return this.host.processes.requestStop(attemptId, stopId, () => this.abortRun(attemptId));
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
