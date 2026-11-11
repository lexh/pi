/**
 * Session coordination contracts in the package's public API: durable records, external events,
 * request admission, runtime lifecycle, the coordination scheduler and managed processes. index.ts
 * re-exports this module in one line, so new coordination exports go here.
 */

export { RuntimeDisposedError, RuntimeReplacementInProgressError } from "./core/agent-session-coordination.ts";
export {
	assertCoordinationSchedulerSupport,
	assertExtensionCoordinationSchedulerSupport,
	COORDINATION_SCHEDULER_CAPABILITIES,
	type CoordinationSchedulerSupport,
	type ExtensionCoordinationSchedulerSupport,
} from "./core/coordination-scheduler-capabilities.ts";
export type {
	CoordinationAdapter,
	CoordinationAdmissionPolicy,
	CoordinationGate,
	CoordinationInspection,
	CoordinationScheduler,
	GrantOperation,
	GrantReceipt,
	PermissionCancellation,
	PermissionScope,
	PermissionSnapshot,
	WaitOperation,
	WaitOutcome,
	WaitTarget,
	WakeClaim,
	WakeTarget,
} from "./core/coordination-scheduler-types.ts";
export {
	ACTIVE_SELECTION,
	assertRecordSupport,
	type EntryReceipt,
	EXTERNAL_RECORD,
	type ExternalRecord,
	type JsonValue,
	RECORD_CAPABILITIES,
	type RecordStore,
	recordKey,
} from "./core/durable-records.ts";
export {
	assertExtensionExternalEventSupport,
	assertExternalEventProjectionSupport,
	EXTERNAL_EVENT_CAPABILITIES,
	type ExtensionExternalEventSupport,
	type ExternalEventProjectionSupport,
} from "./core/external-event-capabilities.ts";
export {
	buildExternalEventDisplay,
	type ExternalEventCard,
	type ExternalEventDisplayInput,
	type ExternalEventDisplayItem,
	type ExternalEventDisposition,
	type ExternalEventViewState,
} from "./core/external-event-projection.ts";
export { ExternalEventReconciler, type ExternalEventRefresh } from "./core/external-event-reconciliation.ts";
export {
	ADMISSION_MESSAGE,
	type AdmissionOrigin,
	EXTERNAL_HISTORY,
	type ExternalHistory,
	type ProjectableExternalRecord,
} from "./core/external-event-records.ts";
export { readLocalProcessBirth } from "./core/managed-process-birth.ts";
export {
	assertExtensionManagedProcessSupport,
	assertManagedProcessSupport,
	MANAGED_PROCESS_CAPABILITIES,
	type ManagedProcessSupport,
} from "./core/managed-process-capabilities.ts";
export type {
	AcknowledgedAttemptImage,
	AttemptImage,
	AttemptIntent,
	AttemptJournalTarget,
	CleanupReceipt,
	CoverageReason,
	JournalRecord,
	ManagedChild,
	ManagedProcessAdapter,
	ManagedProcesses,
	ManagedSpawnOptions,
	ObservedRoot,
	ProcessAuthentication,
	ProcessGap,
	ProcessJournalEntry,
	ProcessJournalPage,
	ProcessKey,
	ProcessProvenance,
	ProcessSource,
	RegistrationReceipt,
	SpawnIntent,
} from "./core/managed-process-types.ts";
export {
	assertExtensionRequestAdmissionSupport,
	assertRequestAdmissionSupport,
	type ExtensionRequestAdmissionSupport,
	REQUEST_ADMISSION_CAPABILITIES,
	type RequestAdmissionSupport,
} from "./core/request-admission-capabilities.ts";
export type {
	AdmissionCandidate,
	AdmissionCommit,
	AdmissionEntry,
	AdmissionProposal,
	AdmissionRecord,
	AdmissionRecovery,
	AdmissionRequest,
	AdmissionSnapshot,
	CanonicalEvent,
	ExternalEventReference,
	ProposedAdmission,
	RequestAdmission,
	RequestAdmissionAdapter,
	RequestDisposition,
	WorkspaceSnapshot,
	WorkspaceState,
} from "./core/request-admission-types.ts";
export {
	assertExtensionRuntimeLifecycleSupport,
	assertRuntimeLifecycleSupport,
	type ExtensionRuntimeLifecycleSupport,
	RUNTIME_LIFECYCLE_CAPABILITIES,
	type RuntimeLifecycleSupport,
} from "./core/runtime-lifecycle-capabilities.ts";
export type {
	AvailableRuntimeInspection,
	ConversationBinding,
	DesiredRuntime,
	HostProcessIdentity,
	HostRuntimeImage,
	HostRuntimeReceipt,
	RuntimeAttachment,
	RuntimeAttachmentRefusal,
	RuntimeAttachmentResult,
	RuntimeExchange,
	RuntimeFence,
	RuntimeInspection,
	RuntimeLifecycle,
	RuntimeReplacementReason,
	RuntimeResourceKind,
	RuntimeRevocationReason,
} from "./core/runtime-lifecycle-types.ts";
