import { writeSync } from "node:fs";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type {
	ConversationBinding,
	HostRuntimeImage,
	HostRuntimeReceipt,
	RuntimeAttachment,
	RuntimeFence,
} from "../../src/core/runtime-lifecycle-types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { FakeRequestCoordinator } from "../helpers/fake-request-coordinator.ts";
import { FakeRuntimeCoordinator } from "../helpers/fake-runtime-coordinator.ts";
import { createHarness } from "../suite/harness.ts";

const [file, phase] = process.argv.slice(2);
if (!file || !phase || !process.send) throw new Error("Expected file, phase and IPC");
const send = (value: unknown) => process.send!(value);
const ack = Promise.withResolvers<void>();
const exchange = Promise.withResolvers<HostRuntimeReceipt>();
process.on("message", (message: { type: string; receipt?: HostRuntimeReceipt }) => {
	if (message.type === "ack") ack.resolve();
	if (message.type === "exchange" && message.receipt) exchange.resolve(message.receipt);
});
const pause = async () => {
	await new Promise<void>(() => {});
};
const manager = SessionManager.open(file);
const h = await createHarness({ sessionManager: manager });
h.session.refreshContext();
const lifecycle = h.session.runtimeLifecycle;
lifecycle.participate();
let attachment: RuntimeAttachment | undefined;
await lifecycle.reconcile(async (image: HostRuntimeImage, authentication) => {
	send({ type: "exchange", image, authentication });
	const receipt = await exchange.promise;
	const result = receipt.results.find((item) => item.status === "attached");
	if (result?.status === "attached") attachment = result.attachment;
	return receipt;
});
class Mirror extends FakeRuntimeCoordinator {
	override assertCurrentFence(fence: RuntimeFence): void {
		if (!lifecycle.isCurrent(fence)) throw new Error("stale fence");
	}
	override attachmentFor(mailboxId: string): RuntimeAttachment | undefined {
		return attachment?.mailboxId === mailboxId ? attachment : undefined;
	}
	override mailboxFor(_binding: ConversationBinding): string | undefined {
		return attachment?.mailboxId;
	}
}
const coordinator = new FakeRequestCoordinator(new Mirror(), undefined, undefined, lifecycle.capture().mailboxId);
const one = coordinator.seedEvent("crash-one", "CRASH_ONE");
coordinator.seedEvent("crash-two", "CRASH_TWO");
coordinator.seedMatchingConsumption(one, "claim");
h.session.requestAdmission.bind(coordinator);
h.session.subscribe((event) => {
	if (event.type === "agent_start") send({ type: "agent-start" });
});
const delivered = coordinator.delivered.bind(coordinator);
coordinator.delivered = async (...args) => {
	await delivered(...args);
	if (phase === "canonical") {
		send({ type: "canonical", image: coordinator.exportRecoveryImage() });
		await pause();
	}
};
const admit = coordinator.admit.bind(coordinator);
coordinator.admit = async (...args) => {
	const result = await admit(...args);
	send({ type: "commit", image: coordinator.exportRecoveryImage() });
	await ack.promise;
	if (phase === "commit") {
		send({ type: "boundary" });
		await pause();
	}
	return result;
};
if (phase === "prefix" || phase === "batch") {
	const append = manager.appendAdmissionBatchOnce.bind(manager);
	manager.appendAdmissionBatchOnce = (entries) => {
		const result = append(phase === "prefix" ? entries.slice(0, 1) : entries);
		writeSync(1, `${phase.toUpperCase()}\n`);
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
		return result;
	};
}
const stream = h.session.agent.streamFunction;
h.session.agent.streamFunction = async (...args) => {
	send({ type: "stream-invoked" });
	const result = await stream(...args);
	send({ type: "provider-invoked", calls: h.faux.state.callCount });
	if (phase === "stream") await pause();
	return result;
};
h.setResponses([fauxAssistantMessage("completed")]);
await h.session.prompt("crash request");
throw new Error("Expected parent to kill child");
