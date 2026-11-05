import { expect } from "vitest";
import { readExternalEntry } from "../../src/core/external-event-records.ts";
import type { ExternalEventReference } from "../../src/core/request-admission-types.ts";
import type { SessionManager } from "../../src/core/session-manager.ts";
import { createAdmissionHarness } from "./request-admission.ts";

export function expectOneAdmission(manager: SessionManager, ref: ExternalEventReference): void {
	const records = manager.getEntries().flatMap((entry) => {
		const record = readExternalEntry(entry);
		return record && record.recipientIdentity === ref.recipientIdentity && record.eventId === ref.eventId
			? [record]
			: [];
	});
	expect(records.filter((record) => record.kind === "canonical")).toHaveLength(1);
	expect(records.filter((record) => record.kind === "admission")).toHaveLength(1);
}

export function expectEnvelopeOnce(messages: readonly unknown[], envelope: string): void {
	const matching = messages.filter((message) => JSON.stringify(message).includes(envelope));
	expect(matching).toHaveLength(1);
	expect(matching[0]).toMatchObject({ role: "user", content: [{ type: "text", text: expect.any(String) }] });
}

export async function createCoordinationHarness(options: Parameters<typeof createAdmissionHarness>[0] = {}) {
	const fixture = await createAdmissionHarness(options);
	return {
		...fixture,
		scheduler: fixture.harness.session.coordinationScheduler,
	};
}
