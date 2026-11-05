import { realpathSync } from "node:fs";
import { assertRecordSupport } from "./durable-records.ts";
import { nextCounter, type RuntimeHost } from "./runtime-host.ts";
import type {
	AvailableRuntimeInspection,
	ConversationBinding,
	DesiredRuntime,
	HostProcessIdentity,
	RuntimeAttachment,
	RuntimeAttachmentRefusal,
	RuntimeExchange,
	RuntimeFence,
	RuntimeLifecycle,
	RuntimeReplacementReason,
	RuntimeResourceKind,
	RuntimeRevocationReason,
	RuntimeVerification,
} from "./runtime-lifecycle-types.ts";
import type { SessionManager } from "./session-manager.ts";

export function resolveConversationBinding(manager: SessionManager): ConversationBinding {
	assertRecordSupport(manager);
	const sessionFile = realpathSync(manager.persistNow());
	return { piSessionId: manager.getSessionId(), sessionFile };
}
type Resource = { kind: RuntimeResourceKind; id: string; revoke: (reason: RuntimeRevocationReason) => void };
export class RuntimeIncarnation implements RuntimeLifecycle {
	readonly #host: RuntimeHost;
	readonly #hostId: string;
	readonly #process: HostProcessIdentity;
	readonly #instanceId: string;
	readonly #incarnation: number;
	readonly #resolve: () => ConversationBinding;
	#conversation?: ConversationBinding;
	#paneId?: string;
	#epoch = 0;
	#state: AvailableRuntimeInspection["state"] = "unregistered";
	#attachment?: RuntimeAttachment;
	#verification?: RuntimeVerification;
	#verificationRevision = 0;
	#resources = new Map<string, Resource>();
	#refusalReason?: RuntimeAttachmentRefusal;
	#facade?: RuntimeLifecycle;
	#observed?: { exchange: RuntimeExchange; connectionId: string; serial: number };
	refusedByOperationId?: string;
	desiredEntryRevision = 0;
	latestRequestedRevision = 0;
	lastAppliedReceiptRevision = 0;
	latestAttemptSerial = 0;
	constructor(
		host: RuntimeHost,
		hostId: string,
		processIdentity: HostProcessIdentity,
		instanceId: string,
		incarnation: number,
		resolve: () => ConversationBinding,
		epoch = 0,
		verification = 0,
		attempt = 0,
	) {
		this.#host = host;
		this.#hostId = hostId;
		this.#process = processIdentity;
		this.#instanceId = instanceId;
		this.#incarnation = incarnation;
		this.#resolve = resolve;
		this.#epoch = epoch;
		this.#verificationRevision = verification;
		this.latestAttemptSerial = attempt;
	}
	get facade(): RuntimeLifecycle {
		if (this.#facade) return this.#facade;
		this.#facade = Object.freeze({
			inspect: () => this.inspect(),
			participate: (options?: { paneId?: string }) => this.participate(options),
			reconcile: (exchange: RuntimeExchange) => this.reconcile(exchange),
			disconnect: () => this.disconnect(),
			capture: () => this.capture(),
			isCurrent: (fence: RuntimeFence) => this.isCurrent(fence),
			cancel: () => this.cancel(),
			track: (fence: RuntimeFence, resource: Resource) => this.track(fence, resource),
		});
		return this.#facade;
	}
	inspect(): AvailableRuntimeInspection {
		return Object.freeze({
			hostId: this.#hostId,
			process: Object.freeze({ ...this.#process }),
			instanceId: this.#instanceId,
			incarnation: this.#incarnation,
			epoch: this.#epoch,
			state: this.#state,
			...(this.#conversation ? { conversation: Object.freeze({ ...this.#conversation }) } : {}),
			...(this.#attachment
				? { mailboxId: this.#attachment.mailboxId, generation: this.#attachment.generation }
				: {}),
			...(this.#refusalReason ? { refusalReason: this.#refusalReason } : {}),
		});
	}
	desired(): DesiredRuntime {
		if (!this.#conversation) throw new Error("Runtime is not participating");
		return Object.freeze({
			instanceId: this.#instanceId,
			incarnation: this.#incarnation,
			epoch: this.#epoch,
			conversation: Object.freeze({ ...this.#conversation }),
			...(this.#paneId === undefined ? {} : { paneId: this.#paneId }),
		});
	}
	assertBinding(): void {
		if (!this.#conversation) return;
		let current: ConversationBinding;
		try {
			current = this.#resolve();
		} catch (error) {
			this.retire("quit");
			throw error;
		}
		if (
			current.piSessionId !== this.#conversation.piSessionId ||
			current.sessionFile !== this.#conversation.sessionFile
		) {
			this.retire("quit");
			throw new Error("Runtime conversation changed; coordination unavailable");
		}
	}
	participate(options?: { paneId?: string }): void {
		if (this.#state === "retired") throw new Error("Runtime retired");
		if (this.#conversation) {
			this.assertBinding();
			if (this.#paneId !== options?.paneId) throw new Error("Runtime pane cannot change");
			if (this.#state !== "refused") return;
		} else {
			this.#conversation = Object.freeze({ ...this.#resolve() });
			this.#paneId = options?.paneId;
		}
		this.#state = "pending";
		this.#refusalReason = undefined;
		this.#host.add(this);
		this.desiredEntryRevision = this.#host.getDesiredImage().revision;
	}
	async reconcile(exchange: RuntimeExchange): Promise<"applied" | "superseded" | "refused"> {
		return this.#host.reconcile(this, exchange);
	}
	disconnect(): void {
		if (this.#state === "retired") return;
		if (this.#observed) this.#host.disconnect(this, this.#observed.exchange, this.#observed.serial);
	}
	observe(exchange: RuntimeExchange, connectionId: string, serial: number): void {
		this.#observed = { exchange, connectionId, serial };
	}
	hasVerification(connectionId: string, serial: number): boolean {
		return this.#verification?.connectionId === connectionId && this.#verification.connectionRevision === serial;
	}
	isObserved(exchange: RuntimeExchange, serial: number): boolean {
		return this.#observed?.exchange === exchange && this.#observed.serial === serial;
	}
	invalidateConnection(connectionId: string, serial: number): void {
		if (this.#verification?.connectionId !== connectionId || this.#verification.connectionRevision !== serial) return;
		this.invalidate();
		if (this.#state === "attached") this.#state = "disconnected";
	}
	matchesDesired(entry: DesiredRuntime, revision: number, operationId: string): boolean {
		if (this.#state === "refused" && this.refusedByOperationId === operationId) return true;
		if (
			this.#state === "retired" ||
			this.#state === "unregistered" ||
			this.#state === "refused" ||
			this.desiredEntryRevision > revision ||
			this.latestRequestedRevision > revision ||
			this.lastAppliedReceiptRevision > revision
		)
			return false;
		return JSON.stringify(this.desired()) === JSON.stringify(entry);
	}
	private invalidate(): void {
		if (this.#attachment || this.#verification) {
			this.#attachment = undefined;
			this.#verification = undefined;
			try {
				this.#verificationRevision = nextCounter(this.#verificationRevision);
			} catch (error) {
				this.#state = "retired";
				try {
					this.#host.remove(this);
				} finally {
					this.drain("runtime-detached");
				}
				throw error;
			}
		}
	}
	capture(): RuntimeFence {
		if (this.#state === "retired") throw new Error("Runtime retired");
		this.assertBinding();
		if (!this.#attachment || !this.#verification) throw new Error("Runtime attachment is not verified");
		return Object.freeze({
			hostId: this.#hostId,
			instanceId: this.#instanceId,
			incarnation: this.#incarnation,
			epoch: this.#epoch,
			mailboxId: this.#attachment.mailboxId,
			generation: this.#attachment.generation,
			generationToken: this.#attachment.generationToken,
			connectionId: this.#verification.connectionId,
			connectionRevision: this.#verification.connectionRevision,
			verificationRevision: this.#verificationRevision,
		});
	}
	isCurrent(fence: RuntimeFence): boolean {
		try {
			const current = this.capture();
			return Object.keys(current).every(
				(key) => current[key as keyof RuntimeFence] === fence[key as keyof RuntimeFence],
			);
		} catch {
			return false;
		}
	}
	track(fence: RuntimeFence, resource: Resource): () => void {
		if (!this.isCurrent(fence)) throw new Error("Runtime fence is stale");
		const key = `${resource.kind}\0${resource.id}`;
		if (this.#resources.has(key)) throw new Error("Resource already tracked");
		this.#resources.set(key, resource);
		return () => {
			if (this.#resources.get(key) === resource) this.#resources.delete(key);
		};
	}
	private drain(reason: RuntimeRevocationReason): void {
		const resources = [...this.#resources.values()];
		this.#resources.clear();
		for (const resource of resources) {
			try {
				resource.revoke(reason);
			} catch {
				console.error("Runtime resource revocation callback failed");
			}
		}
	}
	cancel(): void {
		if (this.#state === "retired") return;
		this.assertBinding();
		try {
			this.invalidate();
			this.#epoch = nextCounter(this.#epoch);
			if (this.#conversation && this.#state !== "refused") {
				this.#state = "pending";
				this.#host.change(this);
				this.desiredEntryRevision = this.#host.getDesiredImage().revision;
			}
		} catch (error) {
			this.#attachment = undefined;
			this.#verification = undefined;
			this.#state = "retired";
			try {
				this.#host.remove(this);
			} finally {
				this.drain("runtime-detached");
			}
			throw error;
		}
		this.drain("cancelled");
	}
	retire(_reason: RuntimeReplacementReason): void {
		if (this.#state === "retired") return;
		this.#state = "retired";
		try {
			this.invalidate();
			if (this.#epoch < Number.MAX_SAFE_INTEGER) this.#epoch = nextCounter(this.#epoch);
		} finally {
			try {
				this.#host.remove(this);
			} finally {
				this.drain("runtime-detached");
			}
		}
	}
	failClosed(): void {
		this.#attachment = undefined;
		this.#verification = undefined;
		this.#state = "retired";
		this.drain("runtime-detached");
	}
	acceptAttachment(attachment: RuntimeAttachment, verification: RuntimeVerification, revision: number): void {
		const same =
			this.#attachment &&
			this.#verification &&
			this.#verification.connectionId === verification.connectionId &&
			this.#verification.connectionRevision === verification.connectionRevision &&
			this.#attachment.generationToken === attachment.generationToken &&
			this.#attachment.generation === attachment.generation &&
			this.#attachment.epoch === attachment.epoch &&
			this.#attachment.mailboxId === attachment.mailboxId;
		if (!same) this.invalidate();
		this.#attachment = Object.freeze({ ...attachment, conversation: Object.freeze({ ...attachment.conversation }) });
		this.#verification = { ...verification };
		this.#state = "attached";
		this.lastAppliedReceiptRevision = revision;
	}
	refuse(reason: RuntimeAttachmentRefusal, operationId: string, revision: number): void {
		this.invalidate();
		this.#state = "refused";
		this.#refusalReason = reason;
		this.refusedByOperationId = operationId;
		this.lastAppliedReceiptRevision = revision;
	}
	drainRefused(): void {
		this.drain("runtime-detached");
	}
}
export function createUnavailableRuntimeLifecycle(reason: string): RuntimeLifecycle {
	const unavailable = () => {
		throw new Error(reason);
	};
	return {
		inspect: () => Object.freeze({ state: "unavailable", reason }),
		participate: unavailable,
		reconcile: async () => unavailable(),
		disconnect: () => {},
		capture: unavailable,
		isCurrent: () => false,
		cancel: () => {},
		track: unavailable,
	};
}
