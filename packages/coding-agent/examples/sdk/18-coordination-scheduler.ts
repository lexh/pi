import {
	type AgentSession,
	assertCoordinationSchedulerSupport,
	assertExternalEventProjectionSupport,
	assertRecordSupport,
	assertRequestAdmissionSupport,
	assertRuntimeLifecycleSupport,
	type CoordinationAdapter,
} from "@earendil-works/pi-coding-agent";

// The caller supplies an existing saved session with an attached runtime and a coordination adapter.
export function bindCoordinationScheduler(session: AgentSession, adapter: CoordinationAdapter): () => void {
	assertRecordSupport(session.sessionManager);
	assertExternalEventProjectionSupport(session);
	assertRuntimeLifecycleSupport(session);
	assertRequestAdmissionSupport(session);
	assertCoordinationSchedulerSupport(session);
	return session.coordinationScheduler.bind(adapter);
}
