/**
 * Session coordination for AgentSession: everything agent-session.ts needs from the coordination
 * modules comes through this one import, and the runtime replacement errors live here.
 */

import { randomUUID } from "node:crypto";

export type { AgentRequestUpdate, PrepareRequestContext } from "@earendil-works/pi-agent-core";
export { CoordinationSchedulerOwner } from "./coordination-scheduler.ts";
export {
	assertCoordinationSchedulerSupport,
	COORDINATION_SCHEDULER_CAPABILITIES,
} from "./coordination-scheduler-capabilities.ts";
export type { CoordinationScheduler, WakeClaim } from "./coordination-scheduler-types.ts";
export { assertOrdinaryCustomType, assertRecordSupport } from "./durable-records.ts";
export type { ExtensionCoordinationActions } from "./extensions/runner.ts";
export { assertExternalEventProjectionSupport, EXTERNAL_EVENT_CAPABILITIES } from "./external-event-capabilities.ts";
export { buildExternalEventDisplay, type ExternalEventDisplayItem } from "./external-event-projection.ts";
export { ExternalEventReconciler, type ExternalEventRefresh } from "./external-event-reconciliation.ts";
export { readExternalEntry } from "./external-event-records.ts";
export { RequestAdmissionOwner } from "./request-admission.ts";
export { assertRequestAdmissionSupport, REQUEST_ADMISSION_CAPABILITIES } from "./request-admission-capabilities.ts";
export type { RequestAdmission } from "./request-admission-types.ts";
export * as runtimeHost from "./runtime-host.ts";
export {
	createUnavailableRuntimeLifecycle,
	type RuntimeIncarnation,
	resolveConversationBinding,
} from "./runtime-incarnation.ts";
export { assertRuntimeLifecycleSupport, RUNTIME_LIFECYCLE_CAPABILITIES } from "./runtime-lifecycle-capabilities.ts";
export type { RuntimeLifecycle } from "./runtime-lifecycle-types.ts";

export class RuntimeReplacementInProgressError extends Error {
	constructor() {
		super("Runtime replacement is already in progress");
		this.name = "RuntimeReplacementInProgressError";
	}
}

export class RuntimeDisposedError extends Error {
	constructor() {
		super("Agent session is disposed");
		this.name = "RuntimeDisposedError";
	}
}

export function newCoordinationRunId(): string {
	return randomUUID();
}
