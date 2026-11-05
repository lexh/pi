import {
	type AgentSession,
	assertExternalEventProjectionSupport,
	assertRecordSupport,
	assertRuntimeLifecycleSupport,
	type RuntimeExchange,
} from "@earendil-works/pi-coding-agent";

export async function attachRuntime(session: AgentSession, exchange: RuntimeExchange): Promise<void> {
	assertRecordSupport(session.sessionManager);
	assertExternalEventProjectionSupport(session);
	assertRuntimeLifecycleSupport(session);
	session.runtimeLifecycle.participate();
	await session.runtimeLifecycle.reconcile(exchange);
	console.log(session.runtimeLifecycle.inspect());
}
