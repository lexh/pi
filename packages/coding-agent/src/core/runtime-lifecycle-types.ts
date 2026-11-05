export interface ConversationBinding {
	readonly piSessionId: string;
	readonly sessionFile: string;
}
export interface HostProcessIdentity {
	readonly pid: number;
	readonly birthNonce: string;
}
export interface DesiredRuntime {
	readonly instanceId: string;
	readonly incarnation: number;
	readonly epoch: number;
	readonly conversation: ConversationBinding;
	readonly paneId?: string;
}
export interface HostRuntimeImage {
	readonly version: 1;
	readonly operationId: string;
	readonly hostId: string;
	readonly process: HostProcessIdentity;
	readonly revision: number;
	readonly maxIncarnation: number;
	readonly runtimes: readonly DesiredRuntime[];
}
export interface RuntimeAttachment extends DesiredRuntime {
	readonly mailboxId: string;
	readonly generation: number;
	readonly generationToken: string;
}
export type RuntimeAttachmentRefusal = "mailbox-busy" | "pane-busy" | "identity-conflict";
export type RuntimeAttachmentResult =
	| { readonly status: "attached"; readonly attachment: RuntimeAttachment }
	| { readonly status: "refused"; readonly runtime: DesiredRuntime; readonly reason: RuntimeAttachmentRefusal };
export interface HostRuntimeReceipt {
	readonly version: 1;
	readonly operationId: string;
	readonly hostId: string;
	readonly revision: number;
	readonly results: readonly RuntimeAttachmentResult[];
}
export type RuntimeExchange = (
	image: HostRuntimeImage,
	authentication: Readonly<{ credential: string }>,
) => Promise<HostRuntimeReceipt>;
export interface RuntimeFence {
	readonly hostId: string;
	readonly instanceId: string;
	readonly incarnation: number;
	readonly epoch: number;
	readonly mailboxId: string;
	readonly generation: number;
	readonly generationToken: string;
	readonly connectionId: string;
	readonly connectionRevision: number;
	readonly verificationRevision: number;
}
export type RuntimeResourceKind = "wait" | "grant" | "claim";
export type RuntimeRevocationReason = "cancelled" | "runtime-detached" | "host-lost";
export type RuntimeReplacementReason = "new" | "resume" | "fork" | "reload" | "quit";
export interface AvailableRuntimeInspection {
	readonly hostId: string;
	readonly process: HostProcessIdentity;
	readonly instanceId: string;
	readonly incarnation: number;
	readonly epoch: number;
	readonly state: "unregistered" | "pending" | "attached" | "disconnected" | "refused" | "retired";
	readonly conversation?: ConversationBinding;
	readonly mailboxId?: string;
	readonly generation?: number;
	readonly refusalReason?: RuntimeAttachmentRefusal;
}
export type RuntimeInspection = AvailableRuntimeInspection | { readonly state: "unavailable"; readonly reason: string };
export interface RuntimeVerification {
	readonly connectionId: string;
	readonly connectionRevision: number;
}
export interface RuntimeLifecycle {
	inspect(): RuntimeInspection;
	participate(options?: { paneId?: string }): void;
	reconcile(exchange: RuntimeExchange): Promise<"applied" | "superseded" | "refused">;
	disconnect(): void;
	capture(): RuntimeFence;
	isCurrent(fence: RuntimeFence): boolean;
	cancel(): void;
	track(
		fence: RuntimeFence,
		resource: { kind: RuntimeResourceKind; id: string; revoke: (reason: RuntimeRevocationReason) => void },
	): () => void;
}
