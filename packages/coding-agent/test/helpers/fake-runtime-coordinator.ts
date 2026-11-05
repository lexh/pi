import { randomUUID } from "node:crypto";
import { canonicalJson } from "../../src/core/durable-records.ts";
import type {
	ConversationBinding,
	DesiredRuntime,
	HostProcessIdentity,
	HostRuntimeImage,
	HostRuntimeReceipt,
	RuntimeAttachment,
	RuntimeAttachmentRefusal,
	RuntimeExchange,
	RuntimeFence,
} from "../../src/core/runtime-lifecycle-types.ts";

type Host = {
	credential: string;
	process: HostProcessIdentity;
	revision: number;
	maxIncarnation: number;
	operations: Map<string, { fingerprint: string; receipt: HostRuntimeReceipt }>;
	instances: Map<string, DesiredRuntime>;
	incarnations: Map<number, string>;
	detached: Set<string>;
	revoked: boolean;
};
type Attached = { hostId: string; attachment: RuntimeAttachment };
type Resource = { hostId: string; instanceId: string; epoch: number; kind: "wait" | "grant" | "claim"; state: string };
type Watch = { hostId: string; instanceId: string; result?: { reason: "runtime-detached" | "host-lost" } };
export interface HeldExchange {
	readonly received: Promise<void>;
	readonly committed: Promise<void>;
	commit(): void;
	respond(): void;
	rejectResponse(error: Error): void;
}

export interface HeldOperation {
	readonly received: Promise<void>;
	readonly committed: Promise<void>;
	readonly response: Promise<void>;
	commit(): void;
	respond(): void;
}

export class FakeRuntimeCoordinator {
	#hosts = new Map<string, Host>();
	#bindings = new Map<string, string>();
	#headers = new Map<string, string>();
	#paths = new Map<string, string>();
	#generations = new Map<string, number>();
	#attached = new Map<string, Attached>();
	#resources = new Map<string, Resource>();
	#operations = new Map<string, string>();
	#waitMatches = new Map<string, string>();
	#watches = new Map<string, Watch>();
	#work = new Map<string, string>();
	// Observational test marker only. Attachment and host-loss decisions never consult it.
	#heartbeatPresent = new Map<string, boolean>();
	#connected = true;
	#held?: {
		public: HeldExchange;
		received: PromiseWithResolvers<void>;
		committed: PromiseWithResolvers<void>;
		response: PromiseWithResolvers<HostRuntimeReceipt>;
		image?: HostRuntimeImage;
		credential?: string;
		result?: HostRuntimeReceipt;
		error?: Error;
		didCommit: boolean;
	};

	readonly exchange: RuntimeExchange = async (image, authentication) => {
		if (!this.#connected) throw new Error("Coordinator disconnected");
		const gate = this.#held;
		if (!gate) return this.commitImage(image, authentication.credential);
		this.#held = undefined;
		gate.image = structuredClone(image);
		gate.credential = authentication.credential;
		gate.received.resolve();
		return gate.response.promise;
	};
	disconnect(): void {
		this.#connected = false;
	}
	reconnect(): void {
		this.#connected = true;
	}
	holdNextExchange(): HeldExchange {
		if (this.#held) throw new Error("Exchange already held");
		const received = Promise.withResolvers<void>();
		const committed = Promise.withResolvers<void>();
		const response = Promise.withResolvers<HostRuntimeReceipt>();
		void committed.promise.catch(() => {});
		const gate = {
			received,
			committed,
			response,
			image: undefined as HostRuntimeImage | undefined,
			credential: undefined as string | undefined,
			result: undefined as HostRuntimeReceipt | undefined,
			error: undefined as Error | undefined,
			didCommit: false,
			public: undefined as unknown as HeldExchange,
		};
		gate.public = {
			received: received.promise,
			committed: committed.promise,
			commit: () => {
				if (!gate.image || gate.credential === undefined || gate.didCommit)
					throw new Error("Held exchange is not ready");
				gate.didCommit = true;
				try {
					gate.result = this.commitImage(gate.image, gate.credential);
					committed.resolve();
				} catch (error) {
					gate.error = error instanceof Error ? error : new Error(String(error));
					committed.reject(gate.error);
					response.reject(gate.error);
				}
			},
			respond: () => {
				if (!gate.didCommit) throw new Error("Exchange not committed");
				if (gate.result) response.resolve(gate.result);
			},
			rejectResponse: (error) => {
				response.reject(error);
			},
		};
		this.#held = gate;
		return gate.public;
	}
	private key(binding: ConversationBinding): string {
		return canonicalJson([binding.piSessionId, binding.sessionFile]);
	}
	mailboxFor(binding: ConversationBinding): string | undefined {
		return this.#bindings.get(this.key(binding));
	}
	seedEndedMailbox(binding: ConversationBinding): string {
		const key = this.key(binding);
		const mailbox = this.#bindings.get(key);
		if (!mailbox) throw new Error("Unknown mailbox");
		if (this.#attached.has(mailbox)) throw new Error("Cannot end attached mailbox");
		this.#bindings.delete(key);
		return mailbox;
	}
	attachmentFor(mailboxId: string): RuntimeAttachment | undefined {
		const entry = this.#attached.get(mailboxId);
		return entry ? structuredClone(entry.attachment) : undefined;
	}
	setHeartbeatPresent(hostId: string, present: boolean): void {
		if (!this.#hosts.has(hostId)) throw new Error("Unknown host");
		this.#heartbeatPresent.set(hostId, present);
	}
	heartbeatPresent(hostId: string): boolean | undefined {
		return this.#heartbeatPresent.get(hostId);
	}
	private validate(image: HostRuntimeImage, credential: string): Host | undefined {
		if (
			!image ||
			image.version !== 1 ||
			typeof image.hostId !== "string" ||
			!image.hostId ||
			typeof image.operationId !== "string" ||
			!image.operationId ||
			typeof credential !== "string" ||
			!credential ||
			!image.process ||
			!Number.isSafeInteger(image.process.pid) ||
			image.process.pid <= 0 ||
			typeof image.process.birthNonce !== "string" ||
			!image.process.birthNonce ||
			!Number.isSafeInteger(image.revision) ||
			image.revision < 0 ||
			!Number.isSafeInteger(image.maxIncarnation) ||
			image.maxIncarnation < 0 ||
			!Array.isArray(image.runtimes)
		)
			throw new Error("Invalid host image");
		const host = this.#hosts.get(image.hostId);
		if (
			host &&
			(host.revoked ||
				host.credential !== credential ||
				host.process.pid !== image.process.pid ||
				host.process.birthNonce !== image.process.birthNonce)
		)
			throw new Error("Host authentication refused");
		const ids = new Set<string>();
		const incarnations = new Set<number>();
		for (const item of image.runtimes) {
			if (
				!item ||
				typeof item.instanceId !== "string" ||
				!item.instanceId ||
				ids.has(item.instanceId) ||
				!Number.isSafeInteger(item.incarnation) ||
				item.incarnation <= 0 ||
				item.incarnation > image.maxIncarnation ||
				incarnations.has(item.incarnation) ||
				!Number.isSafeInteger(item.epoch) ||
				item.epoch < 0 ||
				!item.conversation ||
				typeof item.conversation.piSessionId !== "string" ||
				!item.conversation.piSessionId ||
				typeof item.conversation.sessionFile !== "string" ||
				!item.conversation.sessionFile ||
				(item.paneId !== undefined && (typeof item.paneId !== "string" || !item.paneId))
			)
				throw new Error("Invalid runtime image");
			ids.add(item.instanceId);
			incarnations.add(item.incarnation);
		}
		return host;
	}
	private commitImage(image: HostRuntimeImage, credential: string): HostRuntimeReceipt {
		let host = this.validate(image, credential);
		const fingerprint = canonicalJson(image);
		const previous = host?.operations.get(image.operationId);
		if (previous) {
			if (previous.fingerprint !== fingerprint) throw new Error("Conflicting operation reuse");
			return structuredClone(previous.receipt);
		}
		if (host && (image.revision <= host.revision || image.maxIncarnation < host.maxIncarnation))
			throw new Error("Stale host image");
		for (const item of image.runtimes) {
			const existing = host?.instances.get(item.instanceId);
			if (
				(host?.incarnations.has(item.incarnation) && host.incarnations.get(item.incarnation) !== item.instanceId) ||
				host?.detached.has(item.instanceId) ||
				(existing &&
					(existing.incarnation !== item.incarnation ||
						this.key(existing.conversation) !== this.key(item.conversation) ||
						existing.paneId !== item.paneId ||
						item.epoch < existing.epoch))
			)
				throw new Error("Conflicting runtime identity");
		}
		const proposedPaths = new Map<string, Set<string>>();
		const proposedHeaders = new Map<string, Set<string>>();
		for (const item of image.runtimes) {
			const paths = proposedPaths.get(item.conversation.piSessionId) ?? new Set<string>();
			paths.add(item.conversation.sessionFile);
			proposedPaths.set(item.conversation.piSessionId, paths);
			const headers = proposedHeaders.get(item.conversation.sessionFile) ?? new Set<string>();
			headers.add(item.conversation.piSessionId);
			proposedHeaders.set(item.conversation.sessionFile, headers);
		}
		const dispositions = image.runtimes.map((item) => {
			const bindingKey = this.key(item.conversation);
			const knownPath = this.#headers.get(item.conversation.piSessionId);
			let reason: RuntimeAttachmentRefusal | undefined;
			if (
				(knownPath !== undefined && knownPath !== item.conversation.sessionFile) ||
				(knownPath === undefined && proposedPaths.get(item.conversation.piSessionId)!.size > 1) ||
				(this.#paths.has(item.conversation.sessionFile) &&
					this.#paths.get(item.conversation.sessionFile) !== item.conversation.piSessionId) ||
				(!this.#paths.has(item.conversation.sessionFile) &&
					proposedHeaders.get(item.conversation.sessionFile)!.size > 1)
			)
				reason = "identity-conflict";
			return { item, bindingKey, mailboxId: this.#bindings.get(bindingKey), reason };
		});
		const currentFor = (item: DesiredRuntime) =>
			[...this.#attached.values()].find(
				(entry) => entry.hostId === image.hostId && entry.attachment.instanceId === item.instanceId,
			);
		for (const candidate of dispositions) {
			if (candidate.reason) continue;
			const current = currentFor(candidate.item);
			const contenders = dispositions.filter(
				(other) =>
					other.reason !== "identity-conflict" &&
					other !== candidate &&
					(other.bindingKey === candidate.bindingKey ||
						(candidate.item.paneId !== undefined && other.item.paneId === candidate.item.paneId)),
			);
			if (contenders.length && !current) {
				const incumbent = contenders.find((other) => currentFor(other.item));
				candidate.reason = incumbent
					? incumbent.bindingKey === candidate.bindingKey
						? "mailbox-busy"
						: "pane-busy"
					: contenders.some((other) => other.bindingKey === candidate.bindingKey)
						? "mailbox-busy"
						: "pane-busy";
				continue;
			}
			if (current) continue;
			const occupied = [...this.#attached.values()].filter(
				(entry) =>
					!(
						entry.hostId === image.hostId &&
						!image.runtimes.some((item) => item.instanceId === entry.attachment.instanceId)
					),
			);
			if (candidate.mailboxId && occupied.some((entry) => entry.attachment.mailboxId === candidate.mailboxId))
				candidate.reason = "mailbox-busy";
			else if (candidate.item.paneId && occupied.some((entry) => entry.attachment.paneId === candidate.item.paneId))
				candidate.reason = "pane-busy";
		}
		host ??= {
			credential,
			process: { ...image.process },
			revision: -1,
			maxIncarnation: 0,
			operations: new Map(),
			instances: new Map(),
			incarnations: new Map(),
			detached: new Set(),
			revoked: false,
		};
		this.#hosts.set(image.hostId, host);
		for (const [mailbox, entry] of this.#attached)
			if (
				entry.hostId === image.hostId &&
				!image.runtimes.some((item) => item.instanceId === entry.attachment.instanceId)
			) {
				this.detach(mailbox, "runtime-detached");
				host.detached.add(entry.attachment.instanceId);
			}
		const results: HostRuntimeReceipt["results"][number][] = [];
		for (const candidate of dispositions) {
			const { item } = candidate;
			host.instances.set(item.instanceId, structuredClone(item));
			host.incarnations.set(item.incarnation, item.instanceId);
			if (candidate.reason) {
				results.push({ status: "refused", runtime: structuredClone(item), reason: candidate.reason });
				continue;
			}
			let mailboxId = candidate.mailboxId;
			if (!mailboxId) {
				mailboxId = randomUUID();
				this.#bindings.set(candidate.bindingKey, mailboxId);
				this.#headers.set(item.conversation.piSessionId, item.conversation.sessionFile);
				this.#paths.set(item.conversation.sessionFile, item.conversation.piSessionId);
			}
			const existing = this.#attached.get(mailboxId);
			let attachment: RuntimeAttachment;
			if (existing && existing.hostId === image.hostId && existing.attachment.instanceId === item.instanceId) {
				if (item.epoch > existing.attachment.epoch) this.revoke(image.hostId, item.instanceId, "epoch");
				attachment = { ...existing.attachment, ...structuredClone(item) };
			} else {
				const generation = (this.#generations.get(mailboxId) ?? 0) + 1;
				this.#generations.set(mailboxId, generation);
				attachment = { ...structuredClone(item), mailboxId, generation, generationToken: randomUUID() };
			}
			this.#attached.set(mailboxId, { hostId: image.hostId, attachment });
			results.push({ status: "attached", attachment: structuredClone(attachment) });
		}
		host.revision = image.revision;
		host.maxIncarnation = image.maxIncarnation;
		const receipt: HostRuntimeReceipt = {
			version: 1,
			operationId: image.operationId,
			hostId: image.hostId,
			revision: image.revision,
			results,
		};
		host.operations.set(image.operationId, { fingerprint, receipt: structuredClone(receipt) });
		return receipt;
	}
	private revoke(hostId: string, instanceId: string, reason: "epoch" | "runtime-detached" | "host-lost"): void {
		for (const resource of this.#resources.values())
			if (resource.hostId === hostId && resource.instanceId === instanceId && resource.state === "active")
				resource.state =
					resource.kind === "wait" ? "interrupted" : resource.kind === "grant" ? "revoked" : "retired";
		if (reason !== "epoch")
			for (const watch of this.#watches.values())
				if (watch.hostId === hostId && watch.instanceId === instanceId && !watch.result) watch.result = { reason };
	}
	private detach(mailboxId: string, reason: "runtime-detached" | "host-lost"): void {
		const entry = this.#attached.get(mailboxId);
		if (!entry) return;
		this.#attached.delete(mailboxId);
		this.revoke(entry.hostId, entry.attachment.instanceId, reason);
	}
	private checkFence(fence: RuntimeFence): void {
		const entry = this.#attached.get(fence.mailboxId);
		const a = entry?.attachment;
		if (
			!a ||
			entry.hostId !== fence.hostId ||
			a.instanceId !== fence.instanceId ||
			a.incarnation !== fence.incarnation ||
			a.epoch !== fence.epoch ||
			a.generation !== fence.generation ||
			a.generationToken !== fence.generationToken ||
			this.#hosts.get(fence.hostId)?.revoked
		)
			throw new Error("stale runtime fence");
	}
	detachMailbox(mailboxId: string, reason: "runtime-detached" | "host-lost" = "runtime-detached"): void {
		this.detach(mailboxId, reason);
	}
	assertCurrentFence(fence: RuntimeFence): void {
		this.checkFence(fence);
	}
	canRevokePermissions(fence: RuntimeFence): boolean {
		const entry = this.#attached.get(fence.mailboxId);
		if (!entry) return false;
		if (entry.hostId !== fence.hostId || entry.attachment.instanceId !== fence.instanceId) return false;
		if (entry.attachment.generationToken !== fence.generationToken) {
			throw new Error("stale or forged generation token");
		}
		if (fence.epoch > entry.attachment.epoch) {
			throw new Error("future runtime epoch");
		}
		const host = this.#hosts.get(fence.hostId);
		if (!host || host.revoked) return false;
		if (entry.attachment.incarnation !== fence.incarnation || entry.attachment.generation !== fence.generation) {
			return false;
		}
		return entry.attachment.epoch >= fence.epoch;
	}
	operate(fence: RuntimeFence, operationId: string, kind: "wait" | "grant" | "claim" | "status"): void {
		this.checkFence(fence);
		const fingerprint = canonicalJson([
			fence.hostId,
			fence.instanceId,
			fence.incarnation,
			fence.epoch,
			fence.mailboxId,
			fence.generation,
			fence.generationToken,
			kind,
		]);
		const existing = this.#operations.get(operationId);
		if (existing !== undefined) {
			if (existing !== fingerprint) throw new Error("Conflicting operation reuse");
			return;
		}
		this.#operations.set(operationId, fingerprint);
		if (kind !== "status")
			this.#resources.set(operationId, {
				hostId: fence.hostId,
				instanceId: fence.instanceId,
				epoch: fence.epoch,
				kind,
				state: "active",
			});
	}
	holdOperation(fence: RuntimeFence, operationId: string, kind: "wait" | "grant" | "claim" | "status"): HeldOperation {
		const received = Promise.withResolvers<void>();
		const committed = Promise.withResolvers<void>();
		const response = Promise.withResolvers<void>();
		let didCommit = false;
		let succeeded = false;
		received.resolve();
		return {
			received: received.promise,
			committed: committed.promise,
			response: response.promise,
			commit: () => {
				if (didCommit) throw new Error("Operation already committed");
				didCommit = true;
				try {
					this.operate(fence, operationId, kind);
					succeeded = true;
					committed.resolve();
				} catch (error) {
					committed.reject(error);
					response.reject(error);
				}
			},
			respond: () => {
				if (!succeeded) throw new Error("Operation not committed");
				response.resolve();
			},
		};
	}
	hasOperation(id: string): boolean {
		return this.#operations.has(id);
	}
	seedWaitMatch(fence: RuntimeFence, waitId: string, fact: string): void {
		this.checkFence(fence);
		const wait = this.#resources.get(waitId);
		if (
			!wait ||
			wait.kind !== "wait" ||
			wait.state !== "active" ||
			wait.instanceId !== fence.instanceId ||
			wait.hostId !== fence.hostId ||
			wait.epoch !== fence.epoch
		)
			throw new Error("Wait is not active");
		this.#waitMatches.set(waitId, fact);
	}
	waitMatch(waitId: string): string | undefined {
		return this.#waitMatches.get(waitId);
	}
	activeResourcesFor(fence: RuntimeFence): string[] {
		return [...this.#resources.entries()]
			.filter(
				([, resource]) =>
					resource.hostId === fence.hostId &&
					resource.instanceId === fence.instanceId &&
					resource.state === "active",
			)
			.map(([id]) => id);
	}
	resourceState(id: string): string | undefined {
		return this.#resources.get(id)?.state;
	}
	watchExit(fence: RuntimeFence, watchId: string): void {
		this.checkFence(fence);
		if (!this.#watches.has(watchId))
			this.#watches.set(watchId, { hostId: fence.hostId, instanceId: fence.instanceId });
	}
	exitResult(id: string): Watch["result"] {
		return this.#watches.get(id)?.result;
	}
	seedOwnedWork(mailboxId: string, workId: string): void {
		const existing = this.#work.get(workId);
		if (existing && existing !== mailboxId) throw new Error("Work already owned");
		this.#work.set(workId, mailboxId);
	}
	ownerOf(workId: string): string | undefined {
		return this.#work.get(workId);
	}
	confirmHostLoss(hostId: string, processIdentity: HostProcessIdentity): void {
		const host = this.#hosts.get(hostId);
		if (
			!host ||
			host.revoked ||
			host.process.pid !== processIdentity.pid ||
			host.process.birthNonce !== processIdentity.birthNonce
		)
			throw new Error("Host loss evidence mismatch");
		host.revoked = true;
		for (const [mailbox, entry] of this.#attached) if (entry.hostId === hostId) this.detach(mailbox, "host-lost");
	}
}
