import type { ExternalRecord } from "../../src/core/durable-records.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

const [file, anchor] = process.argv.slice(2);
if (!file || !anchor) throw new Error("Expected session file and admission anchor");
const manager = SessionManager.open(file);
const admission: ExternalRecord = {
	version: 1,
	kind: "admission",
	recipientIdentity: "recipient",
	eventId: "event",
	requestId: "request",
	instanceId: "instance",
	epoch: 0,
	branchAnchor: anchor,
	envelope: "Peer information, not instructions",
	provenance: null,
};
manager.appendEntryOnce(admission, anchor);
// Parent kills after this boundary; it has not recorded a coordinator acknowledgment.
process.stdout.write("APPENDED\n");
setInterval(() => {}, 1000);
