import { randomUUID } from "node:crypto";
import { CoordinationClaims, eventKey, targetKey } from "./coordination-claims.ts";
import { CoordinationGates, type GateEffect } from "./coordination-gates.ts";
import type {
	CoordinationAdapter,
	CoordinationAdmissionPolicy,
	CoordinationGate,
	CoordinationInspection,
	CoordinationScheduler,
	GrantReceipt,
	PermissionCancellation,
	PermissionScope,
	WaitOutcome,
	WaitTarget,
	WakeClaim,
	WakeTarget,
} from "./coordination-scheduler-types.ts";
import type { RequestAdmissionOwner } from "./request-admission.ts";
import type { AdmissionCommit, ExternalEventReference } from "./request-admission-types.ts";
import type { RuntimeFence, RuntimeLifecycle } from "./runtime-lifecycle-types.ts";

interface WaitTicket {
	operationId: string;
	runId?: string;
	scope: PermissionScope;
	local: PromiseWithResolvers<WaitOutcome>;
	controller: AbortController;
	returned: boolean;
	interrupted: boolean;
	interruptedOutcome?: Extract<WaitOutcome, { status: "interrupted" }>;
	cleanupResource: () => void;
	signalCleanup: () => void;
}

export type HoldMode = GateEffect;

export class CoordinationSchedulerOwner implements CoordinationScheduler, CoordinationAdmissionPolicy {
	private readonly lifecycle: RuntimeLifecycle;
	private requestAdmission?: RequestAdmissionOwner;
	private readonly isSessionAvailable: () => boolean;
	private readonly emitNoticeCallback: (text: string) => void;
	private readonly stageReferenceCallback: (reference: ExternalEventReference, fence: RuntimeFence) => void;
	private readonly setContinuationSuppressedCallback: (runId: string) => void;
	private readonly getRunIdCallback: () => string | undefined;
	private readonly requestIdleReconsiderationCallback?: () => void;
	private readonly onBindCallback?: () => void;
	/** False once the conversation's managed task has stopped or ended: no wake or settlement claim may start. */
	private readonly canStartAutomatic: () => boolean;

	private permissionEpoch = 0;
	private readonly claims = new CoordinationClaims();
	private adapter?: CoordinationAdapter;
	private bindingToken?: string;
	private unbindAdmission?: () => void;
	private retired = false;
	private readonly locallyIssuedTargetKeys = new Set<string>();
	private readonly locallyIssuedGrantIds = new Set<string>();
	private readonly grantResourceDisposers = new Map<string, () => void>();
	private readonly waitTickets = new Map<string, WaitTicket>();
	private readonly inFlightGrantsByEpoch = new Map<number, number>();
	private pendingCancellation?: { operation: PermissionCancellation; adapter: CoordinationAdapter };
	private lastValidScope?: PermissionScope;
	private lastBoundAdapter?: CoordinationAdapter;
	private latestRevision = 0;
	private activeClaim?: WakeClaim;
	private pendingActivation?: WakeClaim;
	private reconsiderationScheduled = false;
	private readonly gates = new CoordinationGates();
	private isCancelling = false;

	constructor(
		lifecycle: RuntimeLifecycle,
		requestAdmission: RequestAdmissionOwner | undefined,
		_isSessionActive: () => boolean,
		isSessionAvailable: () => boolean,
		emitNotice: (text: string) => void,
		stageReference: (reference: ExternalEventReference, fence: RuntimeFence) => void,
		setContinuationSuppressed: (runId: string) => void,
		getRunId: () => string | undefined,
		requestIdleReconsideration?: () => void,
		onBind?: () => void,
		canStartAutomatic: () => boolean = () => true,
	) {
		this.lifecycle = lifecycle;
		this.requestAdmission = requestAdmission;
		this.isSessionAvailable = isSessionAvailable;
		this.emitNoticeCallback = emitNotice;
		this.stageReferenceCallback = stageReference;
		this.setContinuationSuppressedCallback = setContinuationSuppressed;
		this.getRunIdCallback = getRunId;
		this.requestIdleReconsiderationCallback = requestIdleReconsideration;
		this.onBindCallback = onBind;
		this.canStartAutomatic = canStartAutomatic;
	}

	setRequestAdmission(owner: RequestAdmissionOwner): void {
		this.requestAdmission = owner;
	}

	get isBound(): boolean {
		return this.adapter !== undefined;
	}

	get claimsBook(): CoordinationClaims {
		return this.claims;
	}

	bind(adapter: CoordinationAdapter): () => void {
		if (this.retired || !this.isSessionAvailable()) {
			throw new Error("Cannot bind retired coordination scheduler");
		}
		if (this.adapter !== undefined || this.requestAdmission?.isBound) {
			throw new Error("Coordination adapter is already bound");
		}
		this.onBindCallback?.();

		// Bind admission first
		const unbindAdmission = this.requestAdmission?.bind(adapter);
		this.unbindAdmission = unbindAdmission;
		this.adapter = adapter;
		this.lastBoundAdapter = adapter;
		const token = randomUUID();
		this.bindingToken = token;
		try {
			this.lastValidScope = this.captureScope();
		} catch {
			// not yet verified
		}

		return () => {
			if (this.bindingToken !== token) return;
			this.bindingToken = undefined;
			this.cancel();
			this.adapter = undefined;
			if (this.unbindAdmission) {
				this.unbindAdmission();
				this.unbindAdmission = undefined;
			}
		};
	}

	retire(): void {
		if (this.retired) return;
		this.retired = true;
		this.cancel();
		this.adapter = undefined;
		this.bindingToken = undefined;
	}

	private captureScope(): PermissionScope {
		const scope = {
			fence: this.lifecycle.capture(),
			permissionEpoch: this.permissionEpoch,
		};
		this.lastValidScope = scope;
		return scope;
	}

	private scopeIsCurrent(scope: PermissionScope): boolean {
		if (this.retired || !this.adapter) return false;
		if (scope.permissionEpoch !== this.permissionEpoch) return false;
		return this.lifecycle.isCurrent(scope.fence);
	}

	private adapterFor(scope: PermissionScope): CoordinationAdapter {
		if (!this.adapter || !this.scopeIsCurrent(scope)) {
			throw new Error("Coordination adapter is not bound or scope is stale");
		}
		return this.adapter;
	}

	async wait(target: WaitTarget, deadline: number, signal?: AbortSignal): Promise<WaitOutcome> {
		const operationId = randomUUID();
		const scope = this.captureScope();
		const local = Promise.withResolvers<WaitOutcome>();
		const controller = new AbortController();
		const ticket = this.registerWaitTicket(operationId, scope, local, controller, signal);

		try {
			const remote = this.adapterFor(scope).wait({ operationId, scope, target, deadline }, controller.signal);
			void remote.catch(() => {});
			const outcome = await Promise.race([remote, local.promise]);
			if (!this.scopeIsCurrent(scope)) return this.interruptWaitTicket(ticket, "runtime-detached");
			if (ticket.interrupted) return this.interruptedOutcome(ticket);
			this.validateWaitOutcome(operationId, outcome, scope.fence.mailboxId);
			if (outcome.status === "interrupted") return this.interruptWaitTicket(ticket, outcome.reason);
			if (outcome.status === "matched") {
				this.stageReferenceCallback(outcome.reference, scope.fence);
				ticket.returned = true;
			} else if (outcome.status === "timeout" || outcome.status === "unanswerable") {
				ticket.returned = true;
			}
			return outcome;
		} catch (error) {
			if (ticket.interrupted) return this.interruptedOutcome(ticket);
			if (!this.scopeIsCurrent(scope)) return this.interruptWaitTicket(ticket, "runtime-detached");
			ticket.returned = true;
			throw error;
		} finally {
			this.detachExternalSignal(ticket);
			this.finishWaitOperation(ticket);
		}
	}

	async grant(target: WakeTarget, signal?: AbortSignal): Promise<GrantReceipt> {
		signal?.throwIfAborted();
		if (!this.canStartAutomatic()) throw new Error("Automatic task execution has ended");
		if (target.kind !== "job" && target.kind !== "idle" && target.kind !== "reply") {
			throw new Error("Unsupported wake target");
		}

		const operationId = randomUUID();
		const scope = this.captureScope();
		const tKey = targetKey(target);
		this.locallyIssuedTargetKeys.add(tKey);

		let revoked = false;
		let grantId: string | undefined;
		const unregisterResource = this.lifecycle.track(scope.fence, {
			kind: "grant",
			id: operationId,
			revoke: () => {
				revoked = true;
				this.claims.revoke();
				if (grantId) {
					const disposer = this.grantResourceDisposers.get(grantId);
					if (disposer) {
						disposer();
						this.grantResourceDisposers.delete(grantId);
					}
				}
			},
		});

		this.inFlightGrantsByEpoch.set(
			scope.permissionEpoch,
			(this.inFlightGrantsByEpoch.get(scope.permissionEpoch) ?? 0) + 1,
		);
		try {
			const receipt = await this.adapterFor(scope).grant({ operationId, scope, target }, signal);
			if (revoked || !this.scopeIsCurrent(scope)) {
				unregisterResource();
				throw new Error("Scope changed during grant");
			}
			if (targetKey(receipt.target) !== tKey) {
				unregisterResource();
				throw new Error("Grant target mismatch");
			}
			grantId = receipt.grantId;
			this.locallyIssuedGrantIds.add(receipt.grantId);
			const effectiveState = this.recordGrant(receipt);
			if (this.grantResourceDisposers.has(receipt.grantId)) {
				unregisterResource();
			} else if (effectiveState !== "consumed" && effectiveState !== "revoked") {
				this.grantResourceDisposers.set(receipt.grantId, unregisterResource);
			} else {
				unregisterResource();
			}
			if (effectiveState === "eligible") {
				this.requestReconsideration();
			}
			return { ...receipt, state: effectiveState };
		} catch (error) {
			unregisterResource();
			throw error;
		} finally {
			const remaining = (this.inFlightGrantsByEpoch.get(scope.permissionEpoch) ?? 1) - 1;
			if (remaining <= 0) {
				this.inFlightGrantsByEpoch.delete(scope.permissionEpoch);
			} else {
				this.inFlightGrantsByEpoch.set(scope.permissionEpoch, remaining);
			}
		}
	}

	private recordGrant(receipt: GrantReceipt): GrantReceipt["state"] {
		this.claims.record(receipt);
		const effectiveState =
			this.claims.inspect().find((item) => item.grantId === receipt.grantId)?.state ?? receipt.state;
		if (effectiveState === "consumed" || effectiveState === "revoked") {
			const disposer = this.grantResourceDisposers.get(receipt.grantId);
			if (disposer) {
				disposer();
				this.grantResourceDisposers.delete(receipt.grantId);
			}
		}
		return effectiveState === "claimed" ? "eligible" : effectiveState;
	}

	async refresh(): Promise<void> {
		if (!this.adapter) return;
		const scope = this.captureScope();
		if (!this.scopeIsCurrent(scope)) return;
		const snapshot = await this.adapter.permissions(scope);
		if (!this.scopeIsCurrent(scope)) return;
		if (snapshot.revision < this.latestRevision) return;
		this.latestRevision = snapshot.revision;

		for (const grant of snapshot.grants) {
			if (
				this.locallyIssuedGrantIds.has(grant.grantId) ||
				this.locallyIssuedTargetKeys.has(targetKey(grant.target))
			) {
				this.recordGrant(grant);
			}
		}
		if (
			this.claims.hasPendingClaim() ||
			this.claims.inspect().some((g) => g.state === "eligible" && !g.blockedReason)
		) {
			this.requestReconsideration();
		}
	}

	async reconcile(): Promise<void> {
		if (this.pendingCancellation) {
			const { operation, adapter } = this.pendingCancellation;
			try {
				await adapter.cancelPermissions(operation);
				if (this.pendingCancellation?.operation.operationId === operation.operationId) {
					this.pendingCancellation = undefined;
				}
			} catch {
				// Retry later on explicit reconcile
			}
		}

		if (!this.adapter) return;
		const scope = this.captureScope();
		if (!this.scopeIsCurrent(scope)) return;

		await this.requestAdmission?.reconcile();

		const snapshot = await this.adapter.permissions(scope);
		if (!this.scopeIsCurrent(scope)) return;
		if (snapshot.revision < this.latestRevision) return;
		this.latestRevision = snapshot.revision;

		for (const grant of snapshot.grants) {
			if (
				this.locallyIssuedGrantIds.has(grant.grantId) ||
				this.locallyIssuedTargetKeys.has(targetKey(grant.target))
			) {
				this.recordGrant(grant);
			}
		}
	}

	cancel(): void {
		if (this.isCancelling) return;

		const hasLivePermissions =
			(this.inFlightGrantsByEpoch.get(this.permissionEpoch) ?? 0) > 0 ||
			[...this.waitTickets.values()].some((t) => !t.interrupted) ||
			(this.activeClaim !== undefined && this.activeClaim.permissionEpoch === this.permissionEpoch) ||
			(this.pendingActivation !== undefined && this.pendingActivation.permissionEpoch === this.permissionEpoch) ||
			this.claims.inspect().some((g) => g.state === "armed" || g.state === "eligible" || g.state === "claimed");

		if (!hasLivePermissions && this.permissionEpoch > 0) {
			return;
		}

		this.isCancelling = true;
		try {
			const nextEpoch = this.permissionEpoch + 1;
			const currentRunId = this.getRunIdCallback();
			const ownsCurrentRequest =
				(this.activeClaim !== undefined && this.activeClaim.permissionEpoch === nextEpoch - 1) ||
				(this.pendingActivation !== undefined && this.pendingActivation.permissionEpoch === nextEpoch - 1) ||
				(currentRunId !== undefined &&
					[...this.waitTickets.values()].some((t) => t.runId === currentRunId && !t.interrupted));

			this.permissionEpoch = nextEpoch;
			this.activeClaim = undefined;
			this.pendingActivation = undefined;

			// Local suppression and revocation first
			this.claims.revoke();

			for (const ticket of this.waitTickets.values()) {
				this.interruptWaitTicket(ticket, "cancelled");
			}

			if (currentRunId && ownsCurrentRequest) {
				this.gates.cancelRun(currentRunId);
			}

			for (const disposer of this.grantResourceDisposers.values()) {
				disposer();
			}
			this.grantResourceDisposers.clear();

			let scopeToCancel = this.lastValidScope;
			try {
				if (this.adapter) {
					scopeToCancel = {
						fence: this.lifecycle.capture(),
						permissionEpoch: nextEpoch - 1,
					};
					this.lastValidScope = scopeToCancel;
				}
			} catch {
				// Disconnected / unavailable lifecycle; use lastValidScope
			}

			const adapterToCancel = this.adapter ?? this.lastBoundAdapter;

			if (scopeToCancel && adapterToCancel) {
				const cancellationOp: PermissionCancellation = {
					operationId: randomUUID(),
					scope: scopeToCancel,
					nextPermissionEpoch: nextEpoch,
				};
				this.pendingCancellation = { operation: cancellationOp, adapter: adapterToCancel };
				void adapterToCancel
					.cancelPermissions(cancellationOp)
					.then(() => {
						if (this.pendingCancellation?.operation.operationId === cancellationOp.operationId) {
							this.pendingCancellation = undefined;
						}
					})
					.catch(() => {});
			}
		} finally {
			this.isCancelling = false;
		}
	}

	inspect(): CoordinationInspection {
		const activeWaits = [...this.waitTickets.values()].filter((t) => !t.returned && !t.interrupted).length;
		let pendingClaim = false;
		try {
			const fence = this.lifecycle.capture();
			if (this.adapter && this.lifecycle.isCurrent(fence)) {
				pendingClaim = this.claims.hasPendingClaim();
			}
		} catch {
			// Disconnected / unavailable
		}
		return {
			bound: this.adapter !== undefined,
			permissionEpoch: this.permissionEpoch,
			activeWaits,
			pendingClaim,
			gates: this.gates.list(),
			grants: this.claims.inspect(),
		};
	}

	claimAtSettlement(lastOutcome?: string): WakeClaim | undefined {
		if (!this.canStartAutomatic() || this.retired || !this.adapter) return undefined;
		if (lastOutcome === "error" || lastOutcome === "aborted") return undefined;
		let scope: PermissionScope;
		try {
			scope = this.captureScope();
			if (!this.lifecycle.isCurrent(scope.fence)) return undefined;
		} catch {
			return undefined;
		}
		const activeWaits = [...this.waitTickets.values()].filter((t) => !t.returned && !t.interrupted).length;
		if (activeWaits > 0) return undefined;
		if (this.hasNewStartHolds()) return undefined;

		return this.claims.claim({
			instanceId: scope.fence.instanceId,
			runtimeEpoch: scope.fence.epoch,
			permissionEpoch: this.permissionEpoch,
		});
	}

	startClaim(claim: WakeClaim): void {
		if (!this.canStartAutomatic()) {
			this.blocked(claim, "task-ended");
			throw new Error("Automatic task execution has ended");
		}
		this.activeClaim = claim;
		this.pendingActivation = claim;
	}

	hold(gate: CoordinationGate, mode: HoldMode): () => void {
		const unhold = this.gates.hold(gate, mode);
		return () => {
			unhold();
			if (!this.gates.blocksNewStarts()) {
				this.requestReconsideration();
			}
		};
	}

	hasNewStartHolds(): boolean {
		return this.gates.blocksNewStarts();
	}

	requestReconsideration(): void {
		if (!this.canStartAutomatic() || this.reconsiderationScheduled || this.retired || !this.adapter) return;
		this.reconsiderationScheduled = true;
		queueMicrotask(() => {
			queueMicrotask(() => {
				this.reconsiderationScheduled = false;
				if (!this.canStartAutomatic() || this.retired || !this.adapter) return;
				this.requestIdleReconsiderationCallback?.();
			});
		});
	}

	// CoordinationAdmissionPolicy implementation
	capture(): WakeClaim | undefined {
		return this.activeClaim;
	}

	async beforeFinalize(signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		const runId = this.getRunIdCallback();
		if (runId) {
			await this.gates.waitForDispatch(runId, signal);
		}
	}

	assertCurrent(claim: WakeClaim): void {
		if (this.retired || !this.adapter) throw new Error("Coordination scheduler is not bound");
		if (claim.permissionEpoch !== this.permissionEpoch) throw new Error("Claim permission epoch is stale");
		const scope = this.captureScope();
		if (!this.lifecycle.isCurrent(scope.fence) || scope.fence.instanceId !== claim.instanceId) {
			throw new Error("Claim runtime scope is stale");
		}
		if (claim.runtimeEpoch !== scope.fence.epoch) {
			throw new Error("Claim runtime epoch is stale");
		}
	}

	committed(commit: AdmissionCommit): void {
		const references = commit.entries.map((entry: AdmissionCommit["entries"][number]) => ({
			recipientIdentity: entry.record.recipientIdentity,
			eventId: entry.record.eventId,
		}));
		this.claims.admitted(references, commit.consumedGrantIds);
		for (const item of this.claims.inspect()) {
			if (item.state === "consumed" || item.state === "revoked") {
				const disposer = this.grantResourceDisposers.get(item.grantId);
				if (disposer) {
					disposer();
					this.grantResourceDisposers.delete(item.grantId);
				}
			}
		}
		if (this.activeClaim) {
			const admittedKeys = new Set(references.map(eventKey));
			const unconsumed = this.activeClaim.targets.filter((t) => !admittedKeys.has(eventKey(t.event)));
			if (unconsumed.length > 0 && references.length > 0) {
				let blockedAny = false;
				for (const target of unconsumed) {
					const grant = this.claims.inspect().find((g) => g.grantId === target.grantId);
					if (grant && grant.state !== "consumed" && grant.state !== "revoked") {
						const disp = commit.dispositions.find(
							(d) =>
								d.recipientIdentity === target.event.recipientIdentity && d.eventId === target.event.eventId,
						);
						this.claims.block(this.activeClaim.claimId, disp?.code ?? "unavailable-at-admission");
						blockedAny = true;
					}
				}
				if (blockedAny) {
					this.emitNoticeCallback(
						"Some wake targets could not be admitted and were blocked; prompt manually or cancel and grant again.",
					);
				}
			}
			this.activeClaim = undefined;
		}
	}

	assistantStarted(): void {
		this.pendingActivation = undefined;
		const runId = this.getRunIdCallback();
		if (runId) {
			this.clearRunTickets(runId);
		}
	}

	blocked(claim: WakeClaim, reason: string): void {
		this.claims.block(claim.claimId, reason);
		if (this.activeClaim?.claimId === claim.claimId) {
			this.activeClaim = undefined;
		}
		if (this.pendingActivation?.claimId === claim.claimId) {
			this.pendingActivation = undefined;
		}
	}

	clearRunTickets(runId: string): void {
		for (const [id, ticket] of this.waitTickets) {
			if (ticket.runId === runId && (ticket.returned || ticket.interrupted)) {
				ticket.cleanupResource();
				this.waitTickets.delete(id);
			}
		}
	}

	clearAllSettledTickets(): void {
		this.pendingActivation = undefined;
		for (const [id, ticket] of this.waitTickets) {
			if (ticket.returned || ticket.interrupted) {
				ticket.cleanupResource();
				this.waitTickets.delete(id);
			}
		}
	}

	private registerWaitTicket(
		operationId: string,
		scope: PermissionScope,
		local: PromiseWithResolvers<WaitOutcome>,
		controller: AbortController,
		signal?: AbortSignal,
	): WaitTicket {
		const ticket: WaitTicket = {
			operationId,
			runId: this.getRunIdCallback(),
			scope,
			local,
			controller,
			returned: false,
			interrupted: false,
			cleanupResource: () => {},
			signalCleanup: () => {},
		};

		const unregisterResource = this.lifecycle.track(scope.fence, {
			kind: "wait",
			id: operationId,
			revoke: (reason) => {
				this.interruptWaitTicket(ticket, reason === "cancelled" ? "cancelled" : "runtime-detached");
			},
		});
		ticket.cleanupResource = unregisterResource;

		if (signal) {
			if (signal.aborted) {
				this.interruptWaitTicket(ticket, "cancelled");
			} else {
				const onAbort = () => {
					this.interruptWaitTicket(ticket, "cancelled");
				};
				signal.addEventListener("abort", onAbort, { once: true });
				ticket.signalCleanup = () => signal.removeEventListener("abort", onAbort);
			}
		}

		this.waitTickets.set(operationId, ticket);
		return ticket;
	}

	private interruptWaitTicket(
		ticket: WaitTicket,
		reason: "cancelled" | "runtime-detached",
	): Extract<WaitOutcome, { status: "interrupted" }> {
		if (ticket.interrupted && ticket.interruptedOutcome) {
			return ticket.interruptedOutcome;
		}
		ticket.interrupted = true;
		ticket.interruptedOutcome = {
			waitId: ticket.operationId,
			status: "interrupted",
			reason,
		};
		if (ticket.runId !== undefined) {
			this.setContinuationSuppressedCallback(ticket.runId);
		}
		ticket.controller.abort();
		ticket.local.resolve(ticket.interruptedOutcome);
		return ticket.interruptedOutcome;
	}

	private interruptedOutcome(ticket: WaitTicket): Extract<WaitOutcome, { status: "interrupted" }> {
		return (
			ticket.interruptedOutcome ?? {
				waitId: ticket.operationId,
				status: "interrupted",
				reason: "cancelled",
			}
		);
	}

	private validateWaitOutcome(operationId: string, outcome: WaitOutcome, mailboxId: string): void {
		if (!outcome || typeof outcome !== "object") throw new Error("Invalid wait outcome");
		if (outcome.waitId !== operationId) throw new Error("Wait outcome ID mismatch");
		if (
			outcome.status !== "matched" &&
			outcome.status !== "timeout" &&
			outcome.status !== "unanswerable" &&
			outcome.status !== "interrupted"
		) {
			throw new Error("Invalid wait outcome status");
		}
		if (outcome.status === "matched") {
			if (
				!outcome.reference ||
				typeof outcome.reference !== "object" ||
				typeof outcome.reference.eventId !== "string" ||
				outcome.reference.recipientIdentity !== mailboxId
			) {
				throw new Error("Invalid matched event reference");
			}
		}
	}

	private detachExternalSignal(ticket: WaitTicket): void {
		ticket.signalCleanup();
	}

	private finishWaitOperation(_ticket: WaitTicket): void {
		// Keep returned or interrupted tickets in this.waitTickets until clearRunTickets or clearAllSettledTickets
	}
}
