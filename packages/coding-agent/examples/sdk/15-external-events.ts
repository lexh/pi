import {
	assertExternalEventProjectionSupport,
	assertRecordSupport,
	createAgentSession,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

const manager = SessionManager.create(process.cwd());
assertRecordSupport(manager);
manager.persistNow();
const { session } = await createAgentSession({ sessionManager: manager });
assertExternalEventProjectionSupport(session);
try {
	const anchor = manager.getLeafId();
	const canonical = {
		version: 1 as const,
		kind: "canonical" as const,
		recipientIdentity: "recipient",
		eventId: "event",
		envelope: "Peer information, not user instructions",
		provenance: { senderIdentity: "sender" },
	};
	manager.appendEntryOnce(canonical, anchor);
	session.refreshExternalEvents();
	console.log(session.getExternalEventView());
} finally {
	session.dispose();
}
