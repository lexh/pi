import type { WakeClaim } from "./coordination-scheduler-types.ts";
import type { EntryReceipt, ExternalRecord } from "./durable-records.ts";
import type { ExternalEventRefresh } from "./external-event-reconciliation.ts";
import type { ConversationBinding, RuntimeFence } from "./runtime-lifecycle-types.ts";

export type CanonicalEvent = Extract<ExternalRecord, { kind: "canonical" }>;
export type AdmissionRecord = Extract<ExternalRecord, { kind: "admission" }>;
export interface ExternalEventReference {
	recipientIdentity: string;
	eventId: string;
}
export interface WorkspaceState {
	commit: string;
	uncommittedDigest: string;
	coverage: "full" | "commit-only";
}
export interface AdmissionCandidate {
	canonical: CanonicalEvent;
	expiresAt: number | null;
	workspaceBasis?: WorkspaceState;
}
export interface RequestDisposition extends ExternalEventReference {
	code: "expired" | "dropped" | "unavailable" | "deferred-budget" | "deferred-transformed" | "already-read";
	reason: string;
}
export interface AdmissionRequest {
	requestId: string;
	conversation: ConversationBinding;
	fence: RuntimeFence;
	branchAnchor: string | null;
	references: readonly ExternalEventReference[];
	activation?: WakeClaim;
}
export interface AdmissionSnapshot {
	candidates: readonly AdmissionCandidate[];
	dispositions: readonly RequestDisposition[];
	view: ExternalEventRefresh;
}
export interface WorkspaceSnapshot {
	recipient: WorkspaceState | null;
	helpers: readonly { recipientIdentity: string; state: WorkspaceState }[];
}
export interface ProposedAdmission {
	entryId: string;
	event: CanonicalEvent;
	receipt: EntryReceipt;
	envelope: string;
}
export interface AdmissionProposal {
	request: AdmissionRequest;
	selected: readonly ProposedAdmission[];
	dispositions: readonly RequestDisposition[];
}
export interface AdmissionEntry {
	entryId: string;
	timestamp: string;
	record: AdmissionRecord;
}
export interface AdmissionCommit {
	requestId: string;
	entries: readonly AdmissionEntry[];
	dispositions: readonly RequestDisposition[];
	view: ExternalEventRefresh;
	consumedGrantIds?: readonly string[];
}
export interface AdmissionRecovery {
	commits: readonly AdmissionCommit[];
	view: ExternalEventRefresh;
}
export interface RequestAdmissionAdapter {
	snapshot(request: AdmissionRequest, signal?: AbortSignal): Promise<AdmissionSnapshot>;
	delivered(request: AdmissionRequest, receipts: readonly EntryReceipt[], signal?: AbortSignal): Promise<void>;
	workspace(request: AdmissionRequest, signal?: AbortSignal): Promise<WorkspaceSnapshot>;
	admit(proposal: AdmissionProposal, signal?: AbortSignal): Promise<AdmissionCommit>;
	lookup(requestId: string): Promise<AdmissionCommit | undefined>;
	recover(conversation: ConversationBinding): Promise<AdmissionRecovery>;
	suppressed(requestId: string): Promise<void>;
}
export interface RequestAdmission {
	bind(adapter: RequestAdmissionAdapter): () => void;
	stageCompletedWait(reference: ExternalEventReference, fence: RuntimeFence): void;
	reconcile(): Promise<void>;
}
