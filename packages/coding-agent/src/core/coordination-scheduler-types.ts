import type { AdmissionCommit, ExternalEventReference, RequestAdmissionAdapter } from "./request-admission-types.ts";
import type { RuntimeFence } from "./runtime-lifecycle-types.ts";

export type WakeTarget =
	| { kind: "job"; attemptId: string }
	| { kind: "idle"; subscriptionId: string }
	| { kind: "reply"; questionId: string; addressedIdentity: string };

export type WaitTarget =
	| WakeTarget
	| { kind: "attempt"; attemptId: string }
	| { kind: "signal"; senderIdentity: string; name: string; correlation: string };

export interface PermissionScope {
	fence: RuntimeFence;
	permissionEpoch: number;
}

export interface WaitOperation {
	operationId: string;
	scope: PermissionScope;
	target: WaitTarget;
	deadline: number;
}

export type WaitOutcome =
	| { waitId: string; status: "matched"; reference: ExternalEventReference }
	| { waitId: string; status: "timeout"; deadline: number }
	| { waitId: string; status: "unanswerable"; reason: "parent-closed" | "answer-deadline" }
	| { waitId: string; status: "interrupted"; reason: "cancelled" | "runtime-detached" };

export interface GrantOperation {
	operationId: string;
	scope: PermissionScope;
	target: WakeTarget;
}

export interface GrantReceipt {
	grantId: string;
	target: WakeTarget;
	state: "armed" | "eligible" | "consumed" | "revoked";
	event?: ExternalEventReference;
}

export interface PermissionSnapshot {
	instanceId: string;
	runtimeEpoch: number;
	permissionEpoch: number;
	revision: number;
	grants: readonly GrantReceipt[];
}

export interface PermissionCancellation {
	operationId: string;
	scope: PermissionScope;
	nextPermissionEpoch: number;
}

export interface WakeClaim {
	claimId: string;
	instanceId: string;
	runtimeEpoch: number;
	permissionEpoch: number;
	targets: readonly { grantId: string; event: ExternalEventReference }[];
}

export interface CoordinationAdapter extends RequestAdmissionAdapter {
	wait(operation: WaitOperation, signal?: AbortSignal): Promise<WaitOutcome>;
	grant(operation: GrantOperation, signal?: AbortSignal): Promise<GrantReceipt>;
	permissions(scope: PermissionScope, signal?: AbortSignal): Promise<PermissionSnapshot>;
	cancelPermissions(operation: PermissionCancellation): Promise<void>;
}

export type CoordinationGate =
	| { kind: "input"; owner: "user" | "model" }
	| { kind: "permission" | "auth"; owner: "model" }
	| { kind: "utility"; owner: "user" }
	| { kind: "compaction" | "navigation"; owner: "runtime" };

export interface CoordinationInspection {
	bound: boolean;
	permissionEpoch: number;
	activeWaits: number;
	pendingClaim: boolean;
	gates: readonly CoordinationGate[];
	grants: readonly {
		grantId: string;
		state: GrantReceipt["state"] | "claimed";
		blockedReason?: string;
	}[];
}

export interface CoordinationScheduler {
	bind(adapter: CoordinationAdapter): () => void;
	wait(target: WaitTarget, deadline: number, signal?: AbortSignal): Promise<WaitOutcome>;
	grant(target: WakeTarget, signal?: AbortSignal): Promise<GrantReceipt>;
	refresh(): Promise<void>;
	reconcile(): Promise<void>;
	cancel(): void;
	inspect(): CoordinationInspection;
}

export interface CoordinationAdmissionPolicy {
	capture(): WakeClaim | undefined;
	beforeFinalize(signal?: AbortSignal): Promise<void>;
	assertCurrent(claim: WakeClaim): void;
	committed(commit: AdmissionCommit): void;
	assistantStarted(): void;
	blocked(claim: WakeClaim, reason: string): void;
}
