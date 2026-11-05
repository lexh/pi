import { randomUUID } from "node:crypto";
import type { GrantReceipt, WakeClaim, WakeTarget } from "./coordination-scheduler-types.ts";
import type { ExternalEventReference } from "./request-admission-types.ts";

export function eventKey(ref: ExternalEventReference): string {
	return JSON.stringify([ref.recipientIdentity, ref.eventId]);
}

export function targetKey(target: WakeTarget): string {
	switch (target.kind) {
		case "job":
			return JSON.stringify(["job", target.attemptId]);
		case "idle":
			return JSON.stringify(["idle", target.subscriptionId]);
		case "reply":
			return JSON.stringify(["reply", target.questionId, target.addressedIdentity]);
	}
}

type LocalGrant = GrantReceipt & { blockedReason?: string };
type ClaimScope = Pick<WakeClaim, "instanceId" | "runtimeEpoch" | "permissionEpoch">;

export class CoordinationClaims {
	private readonly grants = new Map<string, LocalGrant>();
	private readonly consumedGrantIds = new Set<string>();
	private readonly consumedTargets = new Set<string>();
	private readonly consumedEvents = new Set<string>();
	private pending?: WakeClaim;
	private readonly id: () => string;

	constructor(id: () => string = randomUUID) {
		this.id = id;
	}

	record(receipt: GrantReceipt): void {
		const old = this.grants.get(receipt.grantId);
		if (old && targetKey(old.target) !== targetKey(receipt.target)) {
			throw new Error("Conflicting grant target");
		}
		if (old?.event && receipt.event && eventKey(old.event) !== eventKey(receipt.event)) {
			throw new Error("Conflicting grant event");
		}
		const consumed =
			this.consumedGrantIds.has(receipt.grantId) ||
			this.consumedTargets.has(targetKey(receipt.target)) ||
			(receipt.event !== undefined && this.consumedEvents.has(eventKey(receipt.event)));
		const terminal = old?.state === "consumed" || old?.state === "revoked";
		const state = consumed ? "consumed" : terminal ? old.state : receipt.state;
		this.grants.set(receipt.grantId, {
			...structuredClone(receipt),
			state,
			blockedReason: state === "consumed" || state === "revoked" ? undefined : old?.blockedReason,
		});
		if (state === "consumed") {
			this.consumedGrantIds.add(receipt.grantId);
			this.consumedTargets.add(targetKey(receipt.target));
			if (receipt.event) this.consumedEvents.add(eventKey(receipt.event));
		}
		this.retireSatisfiedClaim();
	}

	hasPendingClaim(): boolean {
		return this.pending !== undefined;
	}

	claim(scope: ClaimScope): WakeClaim | undefined {
		if (this.pending) return this.pending;
		const targets = [...this.grants.values()]
			.filter((grant) => grant.state === "eligible" && grant.event && !grant.blockedReason)
			.map((grant) => ({ grantId: grant.grantId, event: { ...grant.event! } }));
		if (targets.length === 0) return undefined;
		this.pending = { ...scope, claimId: this.id(), targets };
		return this.pending;
	}

	admitted(references: readonly ExternalEventReference[], consumedGrantIds?: readonly string[]): void {
		const keys = new Set(references.map(eventKey));
		const idSet = new Set(consumedGrantIds ?? []);
		for (const key of keys) this.consumedEvents.add(key);
		for (const id of idSet) this.consumedGrantIds.add(id);
		for (const grant of this.grants.values()) {
			const matchedByEvent = grant.event !== undefined && keys.has(eventKey(grant.event));
			const matchedById = idSet.has(grant.grantId);
			if (!matchedByEvent && !matchedById) continue;
			grant.state = "consumed";
			grant.blockedReason = undefined;
			this.consumedGrantIds.add(grant.grantId);
			this.consumedTargets.add(targetKey(grant.target));
		}
		this.retireSatisfiedClaim();
	}

	block(claimId: string, reason: string): void {
		if (this.pending?.claimId !== claimId) return;
		for (const target of this.pending.targets) {
			const grant = this.grants.get(target.grantId);
			if (grant && grant.state !== "consumed" && grant.state !== "revoked") {
				grant.blockedReason = reason;
			}
		}
		this.pending = undefined;
	}

	revoke(): void {
		this.pending = undefined;
		for (const grant of this.grants.values()) {
			if (grant.state !== "consumed") grant.state = "revoked";
			grant.blockedReason = undefined;
		}
	}

	inspect(): Array<{ grantId: string; state: GrantReceipt["state"] | "claimed"; blockedReason?: string }> {
		return [...this.grants.values()].map((grant) => ({
			grantId: grant.grantId,
			state:
				grant.state === "eligible" && this.pending?.targets.some((target) => target.grantId === grant.grantId)
					? "claimed"
					: grant.state,
			...(grant.blockedReason ? { blockedReason: grant.blockedReason } : {}),
		}));
	}

	private retireSatisfiedClaim(): void {
		if (
			this.pending?.targets.every((target) => {
				const state = this.grants.get(target.grantId)?.state;
				return state === "consumed" || state === "revoked";
			})
		) {
			this.pending = undefined;
		}
	}
}
