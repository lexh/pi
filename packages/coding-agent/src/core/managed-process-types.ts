import type { ChildProcess } from "node:child_process";
import type { ConversationBinding, HostProcessIdentity, RuntimeFence } from "./runtime-lifecycle-types.ts";
import type { BatchCertificate, FinalizationDeclaration } from "./task-finalization.ts";

export type ProcessKey = { pid: number; birth: string };
export type ProcessSource = "bash" | "user-bash" | "pi-exec" | "extension" | "job";
export type CoverageReason =
	| "registration-outage"
	| "unsupported-tool"
	| "custom-operations"
	| "watch-failed"
	| "scan-failed"
	| "observer-overflow"
	| "observer-outage"
	| "host-journal-lost"
	| "identity-unverifiable"
	| "group-continuity-lost"
	| "lineage-unavailable"
	| "journal-overflow";
export interface SpawnIntent {
	operationId: string;
	spawnId: string;
	attemptId: string;
	toolCallId: string;
	source: ProcessSource;
	pid: number;
	pgid: number;
	marker: string;
}
export interface ObservedRoot extends ProcessKey {
	pgid: number;
	sid: number;
	uniqueId: string | null;
}
export interface CleanupReceipt {
	attemptId: string;
	revision: number;
	spawnIds: string[];
	verdict: "accounted" | "uncertain";
}
export interface ProcessProvenance {
	hostId: string;
	instanceId: string;
	incarnation: number;
	conversation: ConversationBinding;
}
export interface AttemptIntent {
	operationId: string;
	attemptId: string;
	marker: string;
	runId: string | null;
	provenance: ProcessProvenance;
}
export interface ProcessJournalEntry {
	sequence: number;
	intent: SpawnIntent;
	provenance: ProcessProvenance;
	localBirth: string | null;
	released: boolean;
	callEnded: boolean;
	aborted: boolean;
	gaps: CoverageReason[];
}
export interface AttemptImage extends AttemptIntent {
	ended: boolean;
	stopping: boolean;
}
export interface ProcessGap {
	operationId: string;
	attemptId: string;
	toolCallId: string;
	source: ProcessSource;
	reason: CoverageReason;
}
export type JournalRecord =
	| { sequence: number; kind: "attempt"; value: AttemptImage }
	| { sequence: number; kind: "spawn"; value: ProcessJournalEntry }
	| { sequence: number; kind: "gap"; value: ProcessGap };
export interface ProcessJournalPage {
	operationId: string;
	after: number;
	through: number;
	complete: boolean;
	records: JournalRecord[];
}
export interface ProcessAuthentication {
	hostId: string;
	credential: string;
	process: HostProcessIdentity;
}
export interface RegistrationReceipt {
	spawnId: string;
	root: ObservedRoot;
	watchId: string;
	revision: number;
}
/**
 * An acknowledgement of a service stop, sent under the attempt's original launch fence: `requested` once the attempt
 * is latched, `settled` once its local work ended. `registryThrough` is the frozen journal watermark it covers.
 */
export interface StopReceipt {
	operationId: string;
	attemptId: string;
	stopId: string;
	phase: "requested" | "settled";
	registryThrough: number;
}
export interface ManagedProcessAdapter {
	proveHost(auth: ProcessAuthentication, readSelfBirth: () => string | null): Promise<void>;
	open(input: AttemptIntent, fence: RuntimeFence): Promise<{ attemptId: string; marker: string }>;
	register(intent: SpawnIntent, fence: RuntimeFence): Promise<RegistrationReceipt>;
	coverage(input: ProcessGap, fence: RuntimeFence): Promise<void>;
	callEnd(
		input: { operationId: string; attemptId: string; spawnId: string; aborted: boolean },
		fence: RuntimeFence,
	): Promise<void>;
	reconcile(
		image: ProcessJournalPage,
		auth: ProcessAuthentication,
	): Promise<{ acknowledgedThrough: number; cleanup: CleanupReceipt[] }>;
	/** Delivers a frozen full-batch certificate over the host-authenticated retained route. */
	finalize(certificate: BatchCertificate): Promise<"committed" | "superseded">;
	/** Delivers a stop acknowledgement under the attempt's original launch fence. */
	abortReceipt(input: StopReceipt, fence: RuntimeFence): Promise<void>;
}
export interface ManagedSpawnOptions {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	stdio?: ["ignore" | "pipe" | "inherit", "ignore" | "pipe" | "inherit", "ignore" | "pipe" | "inherit"];
}
export interface ManagedChild {
	child: ChildProcess;
	exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}
export interface AttemptJournalTarget {
	attemptId: string;
	version: number;
}
export interface AcknowledgedAttemptImage extends AttemptJournalTarget {
	through: number;
}
export interface ManagedProcesses {
	captureAttemptVersion(attemptId: string): AttemptJournalTarget;
	reconcileAttempt(target: AttemptJournalTarget): Promise<AcknowledgedAttemptImage>;
	bind(adapter: ManagedProcessAdapter): () => void;
	reconcile(): Promise<void>;
	inspect(): {
		pending: number;
		gaps: readonly CoverageReason[];
		stopping: boolean;
		through: number;
		reconciledThrough: number;
	};
	requestStop(attemptId: string, stopId: string): { requested: true; settled: Promise<void> };
	/** Sends a stop acknowledgement through the adapter, under the attempt's original launch fence. */
	acknowledgeStop(receipt: StopReceipt): Promise<void>;
	/** Stages the end of the calling task, effective only if its declaring tool call completes the full batch. */
	declareTaskFinalization(declaration: FinalizationDeclaration): void;
	/** Delivers every pending full-batch certificate; an unanswered one stays pending. */
	reconcileFinalizations(): Promise<void>;
	managedSpawn(command: string, args: readonly string[], options?: ManagedSpawnOptions): Promise<ManagedChild>;
}
