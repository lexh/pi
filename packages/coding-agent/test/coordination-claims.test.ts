import { describe, expect, it } from "vitest";
import { CoordinationClaims } from "../src/core/coordination-claims.ts";

const scope = { instanceId: "instance", runtimeEpoch: 2, permissionEpoch: 0 };
const event = { recipientIdentity: "mailbox", eventId: "job-outcome" };
const eligible = {
	grantId: "g",
	target: { kind: "job" as const, attemptId: "a" },
	state: "eligible" as const,
	event,
};

describe("one-shot coordination claims", () => {
	it("coalesces duplicates and cannot re-arm a consumed target", () => {
		const book = new CoordinationClaims(() => "claim");
		book.record(eligible);
		const first = book.claim(scope);
		expect(first?.targets).toEqual([{ grantId: "g", event }]);
		book.record(eligible);
		expect(book.claim(scope)).toBe(first);
		book.admitted([event]);
		book.record({ ...eligible, grantId: "duplicate-grant-id" });
		expect(book.claim(scope)).toBeUndefined();
		expect(book.inspect().every((item) => item.state === "consumed")).toBe(true);
	});

	it("does not turn repeated unfit notifications into empty requests", () => {
		const book = new CoordinationClaims(() => "claim");
		book.record(eligible);
		const claim = book.claim(scope);
		if (!claim) throw new Error("expected a claim");
		book.block(claim.claimId, "deferred-budget");
		for (let n = 0; n < 10; n++) book.record(eligible);
		expect(book.claim(scope)).toBeUndefined();
		expect(book.inspect()[0].blockedReason).toBe("deferred-budget");
		book.admitted([event]);
		expect(book.inspect()[0].state).toBe("consumed");
	});

	it("claims a finite group and leaves a later target for the next boundary", () => {
		const book = new CoordinationClaims(() => "claim");
		book.record(eligible);
		const first = book.claim(scope);
		book.record({
			...eligible,
			grantId: "g2",
			event: { ...event, eventId: "later" },
			target: { kind: "job", attemptId: "later-attempt" },
		});
		expect(book.claim(scope)).toBe(first);
		expect(first?.targets).toHaveLength(1);
		book.admitted([event]);
		expect(book.claim(scope)?.targets.map((target) => target.event.eventId)).toEqual(["later"]);
	});

	it("handles two-target claim where one member is consumed and one is revoked", () => {
		const book = new CoordinationClaims(() => "claim");
		const event2 = { recipientIdentity: "mailbox", eventId: "reply-outcome" };
		const eligible2 = {
			grantId: "g2",
			target: { kind: "reply" as const, questionId: "q1", addressedIdentity: "helper" },
			state: "eligible" as const,
			event: event2,
		};
		book.record(eligible);
		book.record(eligible2);
		const claim = book.claim(scope);
		expect(claim?.targets).toHaveLength(2);

		book.admitted([event]);
		expect(book.inspect().find((item) => item.grantId === "g")?.state).toBe("consumed");
		expect(book.inspect().find((item) => item.grantId === "g2")?.state).toBe("claimed");

		book.record({ ...eligible2, state: "revoked" });
		expect(book.inspect().find((item) => item.grantId === "g2")?.state).toBe("revoked");
		expect(book.claim(scope)).toBeUndefined();
	});

	it.each([
		{
			name: "armed grant produces no claim",
			receipt: { ...eligible, state: "armed" as const },
			expectClaim: false,
		},
		{
			name: "revoked grant produces no claim",
			receipt: { ...eligible, state: "revoked" as const },
			expectClaim: false,
		},
	])("$name", ({ receipt, expectClaim }) => {
		const book = new CoordinationClaims(() => "claim");
		book.record(receipt);
		expect(book.claim(scope) !== undefined).toBe(expectClaim);
	});

	it("two eligible grants join in one claim", () => {
		const book = new CoordinationClaims(() => "claim");
		const event2 = { recipientIdentity: "mailbox", eventId: "job-2" };
		book.record(eligible);
		book.record({
			grantId: "g2",
			target: { kind: "job", attemptId: "b" },
			state: "eligible",
			event: event2,
		});
		const claim = book.claim(scope);
		expect(claim?.targets).toEqual([
			{ grantId: "g", event },
			{ grantId: "g2", event: event2 },
		]);
	});

	it("throws on conflicting grant target for same grantId", () => {
		const book = new CoordinationClaims(() => "claim");
		book.record(eligible);
		expect(() =>
			book.record({
				...eligible,
				target: { kind: "job", attemptId: "different" },
			}),
		).toThrow("Conflicting grant target");
	});

	it("throws on conflicting grant event for same grantId", () => {
		const book = new CoordinationClaims(() => "claim");
		book.record(eligible);
		expect(() =>
			book.record({
				...eligible,
				event: { ...event, eventId: "different-event" },
			}),
		).toThrow("Conflicting grant event");
	});

	it("consumed receipt arriving before eligible receipt stays consumed", () => {
		const book = new CoordinationClaims(() => "claim");
		book.record({ ...eligible, state: "consumed" });
		book.record({ ...eligible, state: "eligible" });
		expect(book.claim(scope)).toBeUndefined();
		expect(book.inspect()[0].state).toBe("consumed");
	});

	it("revoke() followed by stale eligible replay stays revoked", () => {
		const book = new CoordinationClaims(() => "claim");
		book.record(eligible);
		book.revoke();
		expect(book.inspect()[0].state).toBe("revoked");
		book.record(eligible);
		expect(book.claim(scope)).toBeUndefined();
		expect(book.inspect()[0].state).toBe("revoked");
	});

	it("preserves consumedGrantIds tombstone when armed receipt arrives after admission commit while leaving untouched armed grant armed", () => {
		const book = new CoordinationClaims(() => "claim");
		// Admission commits and consumes grant-late before grant-late's armed receipt is recorded locally
		book.admitted([event], ["grant-late"]);

		const lateArmed = {
			grantId: "grant-late",
			target: { kind: "job" as const, attemptId: "job-late" },
			state: "armed" as const,
		};
		const untouchedArmed = {
			grantId: "grant-untouched",
			target: { kind: "job" as const, attemptId: "job-untouched" },
			state: "armed" as const,
		};

		book.record(lateArmed);
		book.record(untouchedArmed);

		expect(book.inspect()).toEqual([
			{ grantId: "grant-late", state: "consumed" },
			{ grantId: "grant-untouched", state: "armed" },
		]);
		expect(book.claim(scope)).toBeUndefined();
	});
});
