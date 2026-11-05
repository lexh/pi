import { createHash, randomUUID } from "node:crypto";
import { eventKey, targetKey } from "../../src/core/coordination-claims.ts";
import type {
	GrantOperation,
	GrantReceipt,
	PermissionCancellation,
	PermissionScope,
	PermissionSnapshot,
	WaitOperation,
	WaitOutcome,
	WaitTarget,
	WakeTarget,
} from "../../src/core/coordination-scheduler-types.ts";
import { canonicalJson } from "../../src/core/durable-records.ts";
import type { ExternalEventReference } from "../../src/core/request-admission-types.ts";

export interface CoordinationFact {
	reference: ExternalEventReference;
	recordedAt: number;
	match:
		| { kind: "job"; attemptId: string }
		| {
				kind: "idle";
				subscriptionId: string;
				watchedInstanceId: string;
				reason: "idle" | "runtime-detached" | "exited";
		  }
		| { kind: "reply"; questionId: string; senderIdentity: string }
		| { kind: "attempt"; attemptId: string; eventKind: "report" | "checkpoint" }
		| { kind: "signal"; senderIdentity: string; name: string; correlation: string };
}

export type IdleReason = "idle" | "runtime-detached" | "exited";

export interface IdleSubscriptionInput {
	requesterMailbox: string;
	watchedInstanceId: string;
	expiresAt: number;
	observed: "idle" | "busy";
}

export type IdleSubscription = IdleSubscriptionInput & {
	subscriptionId: string;
	result:
		| { status: "pending" }
		| { status: "satisfied"; reason: IdleReason; reference: ExternalEventReference; recordedAt: number }
		| { status: "expired"; recordedAt: number };
};

export type RecordIdleEvent = (
	requesterMailbox: string,
	subscriptionId: string,
	watchedInstanceId: string,
	reason: IdleReason,
	recordedAt: number,
) => ExternalEventReference;

export function matches(target: WaitTarget, fact: CoordinationFact): boolean {
	const match = fact.match;
	switch (target.kind) {
		case "job":
			return match.kind === "job" && match.attemptId === target.attemptId;
		case "idle":
			return match.kind === "idle" && match.subscriptionId === target.subscriptionId;
		case "reply":
			return (
				match.kind === "reply" &&
				match.questionId === target.questionId &&
				match.senderIdentity === target.addressedIdentity
			);
		case "attempt":
			return match.kind === "attempt" && match.attemptId === target.attemptId;
		case "signal":
			return (
				match.kind === "signal" &&
				match.senderIdentity === target.senderIdentity &&
				match.name === target.name &&
				match.correlation === target.correlation
			);
	}
}

interface StoredWait {
	operationId: string;
	operation: WaitOperation;
	result?: WaitOutcome;
	terminalCount: number;
	deferredResponse?: PromiseWithResolvers<WaitOutcome>;
	resolved: boolean;
}

interface StoredGrant {
	grantId: string;
	mailboxId: string;
	instanceId: string;
	runtimeEpoch: number;
	permissionEpoch: number;
	target: WakeTarget;
	state: "armed" | "eligible" | "consumed" | "revoked";
	event?: ExternalEventReference;
}

interface RegisteredQuestion {
	questionId: string;
	ownerMailbox: string;
	addressedIdentity: string;
	answerDeadline: number;
	unanswerableReason?: "parent-closed" | "answer-deadline";
}

export interface CoordinationRecoveryImage {
	facts: CoordinationFact[];
	questions: RegisteredQuestion[];
	consumedTargets: string[];
	attemptMatches: string[];
	minimumPermissionEpochs: Array<[string, number]>;
	subscriptions: IdleSubscription[];
	operations: Array<[string, string]>;
	terminalWaits: Array<{ operationId: string; result: WaitOutcome }>;
	revision: number;
}

export class FakeCoordinationState {
	private readonly facts: CoordinationFact[] = [];
	private readonly questions = new Map<string, RegisteredQuestion>();
	private readonly waits = new Map<string, StoredWait>();
	private readonly grants = new Map<string, StoredGrant>();
	private readonly consumedTargets = new Set<string>();
	private readonly attemptMatches = new Set<string>();
	private readonly minimumPermissionEpochs = new Map<string, number>();
	private readonly subscriptions = new Map<string, IdleSubscription>();
	private readonly operations = new Map<string, string>();
	private revision = 0;

	private readonly clock: () => number;
	private readonly isEventEligible: (ref: ExternalEventReference) => boolean;
	private readonly isEventAdmitted: (ref: ExternalEventReference) => boolean;
	private readonly recordIdleEvent: RecordIdleEvent;

	constructor(
		clock: () => number,
		isEventEligible: (ref: ExternalEventReference) => boolean,
		isEventAdmitted: (ref: ExternalEventReference) => boolean,
		recordIdleEvent: RecordIdleEvent,
		image?: CoordinationRecoveryImage,
	) {
		this.clock = clock;
		this.isEventEligible = isEventEligible;
		this.isEventAdmitted = isEventAdmitted;
		this.recordIdleEvent = recordIdleEvent;
		if (image) {
			this.facts = structuredClone(image.facts);
			for (const q of image.questions) this.questions.set(q.questionId, structuredClone(q));
			this.consumedTargets = new Set(image.consumedTargets);
			this.attemptMatches = new Set(image.attemptMatches);
			this.minimumPermissionEpochs = new Map(image.minimumPermissionEpochs);
			for (const s of image.subscriptions) this.subscriptions.set(s.subscriptionId, structuredClone(s));
			this.operations = new Map(image.operations);
			for (const tw of image.terminalWaits ?? []) {
				this.waits.set(tw.operationId, {
					operationId: tw.operationId,
					operation: undefined as any,
					result: structuredClone(tw.result),
					terminalCount: 1,
					resolved: true,
				});
			}
			this.revision = image.revision;
		}
	}

	getMinimumPermissionEpoch(instanceKey: string): number {
		return this.minimumPermissionEpochs.get(instanceKey) ?? 0;
	}

	private operationFingerprint(op: WaitOperation | GrantOperation | PermissionCancellation): string {
		const {
			connectionId: _c,
			connectionRevision: _cr,
			verificationRevision: _vr,
			generationToken,
			...fence
		} = op.scope.fence;
		const generationTokenDigest = createHash("sha256").update(generationToken).digest("hex");
		return canonicalJson({ ...op, scope: { ...op.scope, fence: { ...fence, generationTokenDigest } } });
	}

	getRevision(): number {
		return this.revision;
	}

	record(fact: CoordinationFact): void {
		this.facts.push({
			...structuredClone(fact),
			reference: {
				recipientIdentity: fact.reference.recipientIdentity,
				eventId: fact.reference.eventId,
			},
		});
		this.facts.sort((a, b) => a.recordedAt - b.recordedAt || a.reference.eventId.localeCompare(b.reference.eventId));
		this.checkPendingWaits();
		this.updateEligibleGrants();
	}

	registerQuestion(questionId: string, ownerMailbox: string, addressedIdentity: string, answerDeadline: number): void {
		this.questions.set(questionId, {
			questionId,
			ownerMailbox,
			addressedIdentity,
			answerDeadline,
		});
	}

	makeUnanswerable(questionId: string, reason: "parent-closed" | "answer-deadline"): void {
		const q = this.questions.get(questionId);
		if (q) q.unanswerableReason = reason;

		// Settle pending reply waits and revoke reply grants synchronously
		for (const wait of this.waits.values()) {
			if (wait.resolved) continue;
			if (wait.operation.target.kind === "reply" && wait.operation.target.questionId === questionId) {
				this.terminateWait(wait, {
					waitId: wait.operationId,
					status: "unanswerable",
					reason,
				});
			}
		}

		for (const grant of this.grants.values()) {
			if (grant.target.kind === "reply" && grant.target.questionId === questionId && grant.state !== "consumed") {
				grant.state = "revoked";
			}
		}
		this.revision++;
	}

	finishDue(): void {
		const now = this.clock();

		// Check expiring subscriptions
		for (const sub of this.subscriptions.values()) {
			if (sub.result.status === "pending" && now >= sub.expiresAt) {
				sub.result = { status: "expired", recordedAt: sub.expiresAt };
			}
		}

		// First check any question answer deadlines and terminate unanswerable reply waits/grants
		for (const q of this.questions.values()) {
			if (now >= q.answerDeadline && !q.unanswerableReason) {
				q.unanswerableReason = "answer-deadline";
			}
			if (q.unanswerableReason) {
				for (const wait of this.waits.values()) {
					if (wait.resolved) continue;
					if (
						wait.operation &&
						wait.operation.target.kind === "reply" &&
						wait.operation.target.questionId === q.questionId
					) {
						this.terminateWait(wait, {
							waitId: wait.operationId,
							status: "unanswerable",
							reason: q.unanswerableReason,
						});
					}
				}
				for (const grant of this.grants.values()) {
					if (
						grant.target.kind === "reply" &&
						grant.target.questionId === q.questionId &&
						grant.state !== "consumed"
					) {
						grant.state = "revoked";
					}
				}
			}
		}

		// Then check any waits that can match due to facts recorded by deadline
		this.checkPendingWaits();

		// Then time out remaining due waits
		for (const wait of this.waits.values()) {
			if (wait.resolved) continue;
			if (now >= wait.operation.deadline) {
				this.terminateWait(wait, {
					waitId: wait.operationId,
					status: "timeout",
					deadline: wait.operation.deadline,
				});
			}
		}
	}

	inspectWait(waitId: string): { result?: WaitOutcome; terminalCount: number } | undefined {
		const wait = this.waits.get(waitId);
		if (!wait) return undefined;
		return {
			result: wait.result ? structuredClone(wait.result) : undefined,
			terminalCount: wait.terminalCount,
		};
	}

	inspectGrant(grantId: string): (GrantReceipt & { state: string }) | undefined {
		const grant = this.grants.get(grantId);
		if (!grant) return undefined;
		return {
			grantId: grant.grantId,
			target: structuredClone(grant.target),
			state: grant.state,
			...(grant.event ? { event: structuredClone(grant.event) } : {}),
		};
	}

	registerIdleSubscription(input: IdleSubscriptionInput): IdleSubscription {
		const now = this.clock();
		if (now >= input.expiresAt) {
			const sub: IdleSubscription = {
				...structuredClone(input),
				subscriptionId: randomUUID(),
				result: { status: "expired", recordedAt: input.expiresAt },
			};
			this.subscriptions.set(sub.subscriptionId, sub);
			return structuredClone(sub);
		}

		// Coalesce pending subscription for (requesterMailbox, watchedInstanceId)
		for (const sub of this.subscriptions.values()) {
			if (
				sub.requesterMailbox === input.requesterMailbox &&
				sub.watchedInstanceId === input.watchedInstanceId &&
				sub.result.status === "pending"
			) {
				return structuredClone(sub);
			}
		}

		const subscriptionId = randomUUID();
		const sub: IdleSubscription = {
			...structuredClone(input),
			subscriptionId,
			result: { status: "pending" },
		};

		if (input.observed === "idle") {
			const ref = this.recordIdleEvent(input.requesterMailbox, subscriptionId, input.watchedInstanceId, "idle", now);
			sub.result = { status: "satisfied", reason: "idle", reference: ref, recordedAt: now };
			this.subscriptions.set(subscriptionId, sub);
			this.record({
				reference: ref,
				recordedAt: now,
				match: { kind: "idle", subscriptionId, watchedInstanceId: input.watchedInstanceId, reason: "idle" },
			});
		} else {
			this.subscriptions.set(subscriptionId, sub);
		}
		return structuredClone(sub);
	}

	satisfyIdleSubscriptions(watchedInstanceId: string, reason: IdleReason): void {
		const now = this.clock();
		for (const sub of this.subscriptions.values()) {
			if (sub.watchedInstanceId === watchedInstanceId && sub.result.status === "pending") {
				if (now >= sub.expiresAt) {
					sub.result = { status: "expired", recordedAt: sub.expiresAt };
					continue;
				}
				const ref = this.recordIdleEvent(sub.requesterMailbox, sub.subscriptionId, watchedInstanceId, reason, now);
				sub.result = { status: "satisfied", reason, reference: ref, recordedAt: now };
				this.record({
					reference: ref,
					recordedAt: now,
					match: { kind: "idle", subscriptionId: sub.subscriptionId, watchedInstanceId, reason },
				});
			}
		}
	}

	inspectSubscription(subscriptionId: string): IdleSubscription | undefined {
		const sub = this.subscriptions.get(subscriptionId);
		return sub ? structuredClone(sub) : undefined;
	}

	async wait(operation: WaitOperation, signal?: AbortSignal): Promise<WaitOutcome> {
		signal?.throwIfAborted();

		const fingerprint = this.operationFingerprint(operation);
		const oldFingerprint = this.operations.get(operation.operationId);
		if (oldFingerprint && oldFingerprint !== fingerprint) {
			throw new Error("Conflicting wait operation arguments");
		}

		const existing = this.waits.get(operation.operationId);
		if (existing) {
			if (existing.result) return structuredClone(existing.result);
			if (existing.deferredResponse) return existing.deferredResponse.promise;
		}

		const instanceKey = `${operation.scope.fence.mailboxId}:${operation.scope.fence.instanceId}`;
		const floor = this.minimumPermissionEpochs.get(instanceKey) ?? 0;
		if (operation.scope.permissionEpoch < floor) {
			return {
				waitId: operation.operationId,
				status: "interrupted",
				reason: "cancelled",
			};
		}

		this.operations.set(operation.operationId, fingerprint);
		const stored: StoredWait = {
			operationId: operation.operationId,
			operation: structuredClone(operation),
			terminalCount: 0,
			deferredResponse: Promise.withResolvers<WaitOutcome>(),
			resolved: false,
		};
		this.waits.set(operation.operationId, stored);

		// Check if it already matches a retained eligible fact
		const match = this.findMatchingFact(stored);
		if (match) {
			if (stored.operation.target.kind === "attempt") {
				const ledgerKey = `${stored.operation.scope.fence.mailboxId}:${stored.operation.scope.fence.instanceId}:${eventKey(match.reference)}`;
				this.attemptMatches.add(ledgerKey);
			}
			this.terminateWait(stored, {
				waitId: operation.operationId,
				status: "matched",
				reference: match.reference,
			});
			return stored.result!;
		}

		// Check if question is already unanswerable (parent closed or answer deadline passed)
		const now = this.clock();
		if (operation.target.kind === "reply") {
			const q = this.questions.get(operation.target.questionId);
			if (q?.unanswerableReason || (q && now >= q.answerDeadline)) {
				this.terminateWait(stored, {
					waitId: operation.operationId,
					status: "unanswerable",
					reason: q?.unanswerableReason ?? "answer-deadline",
				});
				return stored.result!;
			}
		}

		// Check if it is already past deadline
		if (now >= operation.deadline) {
			this.terminateWait(stored, {
				waitId: operation.operationId,
				status: "timeout",
				deadline: operation.deadline,
			});
			return stored.result!;
		}

		return stored.deferredResponse!.promise;
	}

	async grant(operation: GrantOperation, signal?: AbortSignal): Promise<GrantReceipt> {
		signal?.throwIfAborted();
		const target = operation.target;
		if (target.kind !== "job" && target.kind !== "idle" && target.kind !== "reply") {
			throw new Error("Unsupported wake target");
		}

		const instanceKey = `${operation.scope.fence.mailboxId}:${operation.scope.fence.instanceId}`;
		const floor = this.minimumPermissionEpochs.get(instanceKey) ?? 0;
		if (operation.scope.permissionEpoch < floor) {
			throw new Error("Stale permission epoch");
		}

		const fingerprint = this.operationFingerprint(operation);
		const oldFingerprint = this.operations.get(operation.operationId);
		if (oldFingerprint && oldFingerprint !== fingerprint) {
			throw new Error("Conflicting grant operation arguments");
		}
		this.operations.set(operation.operationId, fingerprint);

		if (target.kind === "reply") {
			const question = this.questions.get(target.questionId);
			if (
				!question ||
				question.ownerMailbox !== operation.scope.fence.mailboxId ||
				question.addressedIdentity !== target.addressedIdentity
			) {
				throw new Error("Question not asked by this mailbox to this identity");
			}
		}

		const tKey = targetKey(target);
		const consumedKey = `${instanceKey}:${tKey}`;

		if (this.consumedTargets.has(consumedKey)) {
			return {
				grantId: randomUUID(),
				target: structuredClone(target),
				state: "consumed",
			};
		}

		// Duplicate outstanding grants share one receipt
		for (const grant of this.grants.values()) {
			if (
				grant.mailboxId === operation.scope.fence.mailboxId &&
				grant.instanceId === operation.scope.fence.instanceId &&
				grant.permissionEpoch === operation.scope.permissionEpoch &&
				targetKey(grant.target) === tKey &&
				grant.state !== "consumed" &&
				grant.state !== "revoked"
			) {
				return {
					grantId: grant.grantId,
					target: structuredClone(grant.target),
					state: grant.state,
					...(grant.event ? { event: structuredClone(grant.event) } : {}),
				};
			}
		}

		const now = this.clock();

		// Check if question is already unanswerable or expired
		if (target.kind === "reply") {
			const question = this.questions.get(target.questionId);
			if (question?.unanswerableReason || (question && now >= question.answerDeadline)) {
				return {
					grantId: randomUUID(),
					target: structuredClone(target),
					state: "revoked",
				};
			}
		}

		// Check if an eligible fact exists
		const matchingFact = this.facts.find(
			(fact) =>
				matches(target, fact) &&
				this.isEventEligible(fact.reference) &&
				fact.reference.recipientIdentity === operation.scope.fence.mailboxId,
		);

		const grantId = randomUUID();
		const state: GrantReceipt["state"] = matchingFact ? "eligible" : "armed";
		const storedGrant: StoredGrant = {
			grantId,
			mailboxId: operation.scope.fence.mailboxId,
			instanceId: operation.scope.fence.instanceId,
			runtimeEpoch: operation.scope.fence.epoch,
			permissionEpoch: operation.scope.permissionEpoch,
			target: structuredClone(target),
			state,
			...(matchingFact ? { event: structuredClone(matchingFact.reference) } : {}),
		};

		this.grants.set(grantId, storedGrant);
		this.revision++;

		return {
			grantId,
			target: structuredClone(target),
			state,
			...(matchingFact ? { event: structuredClone(matchingFact.reference) } : {}),
		};
	}

	async permissions(scope: PermissionScope, signal?: AbortSignal): Promise<PermissionSnapshot> {
		signal?.throwIfAborted();
		const instanceKey = `${scope.fence.mailboxId}:${scope.fence.instanceId}`;
		const floor = this.minimumPermissionEpochs.get(instanceKey) ?? 0;
		if (scope.permissionEpoch < floor) {
			return {
				instanceId: scope.fence.instanceId,
				runtimeEpoch: scope.fence.epoch,
				permissionEpoch: scope.permissionEpoch,
				revision: this.revision,
				grants: [],
			};
		}

		const grants: GrantReceipt[] = [];
		for (const grant of this.grants.values()) {
			if (
				grant.mailboxId === scope.fence.mailboxId &&
				grant.instanceId === scope.fence.instanceId &&
				grant.permissionEpoch === scope.permissionEpoch
			) {
				grants.push({
					grantId: grant.grantId,
					target: structuredClone(grant.target),
					state: grant.state,
					...(grant.event ? { event: structuredClone(grant.event) } : {}),
				});
			}
		}
		return {
			instanceId: scope.fence.instanceId,
			runtimeEpoch: scope.fence.epoch,
			permissionEpoch: scope.permissionEpoch,
			revision: this.revision,
			grants,
		};
	}

	cancelPermissions(operation: PermissionCancellation, canRevoke: boolean): void {
		const opFingerprint = this.operationFingerprint(operation);
		const existingOp = this.operations.get(operation.operationId);
		if (existingOp) {
			if (existingOp !== opFingerprint) throw new Error("Conflicting cancellation operation arguments");
			return;
		}
		this.operations.set(operation.operationId, opFingerprint);

		if (!canRevoke) {
			// Nonmutating success on false
			return;
		}

		const instanceKey = `${operation.scope.fence.mailboxId}:${operation.scope.fence.instanceId}`;
		const currentFloor = this.minimumPermissionEpochs.get(instanceKey) ?? 0;
		if (operation.nextPermissionEpoch > currentFloor) {
			this.minimumPermissionEpochs.set(instanceKey, operation.nextPermissionEpoch);
		}

		// Terminate pending lower-epoch waits with recorded interruption
		for (const wait of this.waits.values()) {
			if (wait.resolved) continue;
			if (
				wait.operation.scope.fence.mailboxId === operation.scope.fence.mailboxId &&
				wait.operation.scope.fence.instanceId === operation.scope.fence.instanceId &&
				wait.operation.scope.permissionEpoch < operation.nextPermissionEpoch
			) {
				this.terminateWait(wait, {
					waitId: wait.operationId,
					status: "interrupted",
					reason: "cancelled",
				});
			}
		}

		// Revoke lower-epoch grants
		for (const grant of this.grants.values()) {
			if (
				grant.mailboxId === operation.scope.fence.mailboxId &&
				grant.instanceId === operation.scope.fence.instanceId &&
				grant.permissionEpoch < operation.nextPermissionEpoch &&
				grant.state !== "consumed"
			) {
				grant.state = "revoked";
			}
		}

		this.revision++;
	}

	getActiveGrants(
		mailboxId: string,
		instanceId: string,
		runtimeEpoch?: number,
		permissionEpoch?: number,
	): StoredGrant[] {
		const floor = this.getMinimumPermissionEpoch(`${mailboxId}:${instanceId}`);
		return [...this.grants.values()].filter(
			(grant) =>
				grant.mailboxId === mailboxId &&
				grant.instanceId === instanceId &&
				(grant.state === "eligible" || grant.state === "armed") &&
				grant.permissionEpoch >= floor &&
				(runtimeEpoch === undefined || grant.runtimeEpoch === runtimeEpoch) &&
				(permissionEpoch === undefined || grant.permissionEpoch === permissionEpoch),
		);
	}

	markConsumed(mailboxId: string, instanceId: string, target: WakeTarget): void {
		const instanceKey = `${mailboxId}:${instanceId}`;
		const tKey = targetKey(target);
		this.consumedTargets.add(`${instanceKey}:${tKey}`);
	}

	isConsumed(mailboxId: string, instanceId: string, target: WakeTarget): boolean {
		const instanceKey = `${mailboxId}:${instanceId}`;
		return this.consumedTargets.has(`${instanceKey}:${targetKey(target)}`);
	}

	exportRecoveryImage(): CoordinationRecoveryImage {
		const terminalWaits = [...this.waits.values()]
			.filter((w) => w.resolved && w.result)
			.map((w) => ({ operationId: w.operationId, result: structuredClone(w.result!) }));
		return {
			facts: structuredClone(this.facts),
			questions: [...this.questions.values()].map((q) => structuredClone(q)),
			consumedTargets: [...this.consumedTargets],
			attemptMatches: [...this.attemptMatches],
			minimumPermissionEpochs: [...this.minimumPermissionEpochs],
			subscriptions: [...this.subscriptions.values()].map((s) => structuredClone(s)),
			operations: [...this.operations],
			terminalWaits,
			revision: this.revision,
		};
	}

	private findMatchingFact(wait: StoredWait): CoordinationFact | undefined {
		const { target, deadline, scope } = wait.operation;
		for (const fact of this.facts) {
			if (fact.recordedAt > deadline) continue;
			if (!matches(target, fact)) continue;
			if (fact.reference.recipientIdentity !== scope.fence.mailboxId) continue;
			if (!this.isEventEligible(fact.reference)) continue;

			if (target.kind === "reply") {
				const q = this.questions.get(target.questionId);
				if (q && (fact.recordedAt > q.answerDeadline || q.unanswerableReason)) continue;
			}

			if (target.kind === "attempt") {
				if (this.isEventAdmitted(fact.reference)) continue;
				const ledgerKey = `${scope.fence.mailboxId}:${scope.fence.instanceId}:${eventKey(fact.reference)}`;
				if (this.attemptMatches.has(ledgerKey)) continue;
			}
			return fact;
		}
		return undefined;
	}

	private checkPendingWaits(): void {
		for (const wait of this.waits.values()) {
			if (wait.resolved) continue;
			const fact = this.findMatchingFact(wait);
			if (fact) {
				if (wait.operation.target.kind === "attempt") {
					const ledgerKey = `${wait.operation.scope.fence.mailboxId}:${wait.operation.scope.fence.instanceId}:${eventKey(fact.reference)}`;
					this.attemptMatches.add(ledgerKey);
				}
				this.terminateWait(wait, {
					waitId: wait.operationId,
					status: "matched",
					reference: structuredClone(fact.reference),
				});
			}
		}
	}

	private updateEligibleGrants(): void {
		const now = this.clock();
		for (const grant of this.grants.values()) {
			if (grant.state !== "armed") continue;
			if (grant.target.kind === "reply") {
				const q = this.questions.get(grant.target.questionId);
				if (q && (now >= q.answerDeadline || q.unanswerableReason)) {
					grant.state = "revoked";
					this.revision++;
					continue;
				}
			}
			const matchingFact = this.facts.find(
				(fact) =>
					matches(grant.target, fact) &&
					this.isEventEligible(fact.reference) &&
					fact.reference.recipientIdentity === grant.mailboxId &&
					(grant.target.kind !== "reply" ||
						!this.questions.get(grant.target.questionId)?.answerDeadline ||
						fact.recordedAt <= this.questions.get(grant.target.questionId)!.answerDeadline),
			);
			if (matchingFact) {
				grant.state = "eligible";
				grant.event = structuredClone(matchingFact.reference);
				this.revision++;
			}
		}
	}

	private terminateWait(wait: StoredWait, outcome: WaitOutcome): void {
		wait.result = structuredClone(outcome);
		wait.resolved = true;
		wait.terminalCount++;
		wait.deferredResponse?.resolve(wait.result);
	}
}
