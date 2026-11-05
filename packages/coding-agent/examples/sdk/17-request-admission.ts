import {
	type AgentSession,
	assertExternalEventProjectionSupport,
	assertRecordSupport,
	assertRequestAdmissionSupport,
	assertRuntimeLifecycleSupport,
	type RequestAdmissionAdapter,
} from "@earendil-works/pi-coding-agent";

// The caller supplies an existing saved session with an attached runtime and an adapter.
export function bindRequestAdmission(session: AgentSession, adapter: RequestAdmissionAdapter): () => void {
	assertRecordSupport(session.sessionManager);
	assertExternalEventProjectionSupport(session);
	assertRuntimeLifecycleSupport(session);
	assertRequestAdmissionSupport(session);
	return session.requestAdmission.bind(adapter);
}
