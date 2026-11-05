import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { eventKey } from "../../src/core/coordination-claims.ts";
import type {
	CoordinationAdapter,
	GrantOperation,
	GrantReceipt,
	PermissionCancellation,
	PermissionScope,
	PermissionSnapshot,
	WaitOperation,
	WaitOutcome,
} from "../../src/core/coordination-scheduler-types.ts";
import { canonicalJson, type EntryReceipt, recordKey } from "../../src/core/durable-records.ts";
import { readStrictSession } from "../../src/core/durable-session-io.ts";
import type { ExternalEventRefresh } from "../../src/core/external-event-reconciliation.ts";
import type {
	AdmissionCommit,
	AdmissionProposal,
	AdmissionRecovery,
	AdmissionRequest,
	AdmissionSnapshot,
	CanonicalEvent,
	RequestDisposition,
	WorkspaceSnapshot,
	WorkspaceState,
} from "../../src/core/request-admission-types.ts";
import type { ConversationBinding } from "../../src/core/runtime-lifecycle-types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { canonical } from "./external-events.ts";
import { type CoordinationRecoveryImage, FakeCoordinationState } from "./fake-coordination-state.ts";
import type { FakeRuntimeCoordinator } from "./fake-runtime-coordinator.ts";

type Event = {
	canonical: CanonicalEvent;
	expiresAt: number | null;
	state: "pending" | "read" | "dropped" | "expired";
	deliveredAt: number | null;
	readAt: number | null;
	receipt: EntryReceipt | null;
};
type StoredProposal = Omit<AdmissionProposal, "request"> & {
	request: Omit<AdmissionRequest, "fence"> & {
		fence: Omit<
			AdmissionRequest["fence"],
			"connectionId" | "connectionRevision" | "verificationRevision" | "generationToken"
		> & { generationTokenDigest: string };
	};
};
type StoredRequest = {
	fingerprint: string;
	proposal: StoredProposal;
	conversation: ConversationBinding;
	result: AdmissionCommit;
	suppressed: boolean;
};
export interface RequestRecoveryImage {
	events: Event[];
	requests: StoredRequest[];
	consumption: Array<[string, string | null]>;
	coordination?: CoordinationRecoveryImage;
	revision: number;
}
export interface HeldAdmission {
	received: Promise<void>;
	committed: Promise<void>;
	commit(): void;
	respond(): void;
	rejectResponse(error: Error): void;
}

export class FakeRequestCoordinator implements CoordinationAdapter {
	private events = new Map<string, Event>();
	private requests = new Map<string, StoredRequest>();
	private consumption = new Map<string, string | null>();
	private revision = 0;
	private omittedCandidates = new Set<string>();
	private workspaceState: WorkspaceSnapshot = { recipient: null, helpers: [] };
	private readonly requestBasis = new Map<string, WorkspaceSnapshot>();
	private readonly eventBasis = new Map<string, WorkspaceState>();
	readonly coordination: FakeCoordinationState;

	setWorkspace(snapshot: WorkspaceSnapshot): void {
		this.workspaceState = structuredClone(snapshot);
	}

	acceptMailFromRequest(
		requestId: string,
		recipient: FakeRequestCoordinator,
		eventId: string,
		body: string,
		cited?: WorkspaceState,
	): CanonicalEvent {
		const basis =
			cited ??
			this.requestBasis
				.get(requestId)
				?.helpers.find((helper) => helper.recipientIdentity === recipient.recipientIdentity)?.state;
		if (!basis) throw new Error("No workspace basis for request");
		const event = recipient.seedEvent(eventId, body);
		recipient.eventBasis.set(recipient.key(event), structuredClone(basis));
		return event;
	}

	omitOrdinaryCandidate(reference: { recipientIdentity: string; eventId: string }): void {
		this.omittedCandidates.add(this.key(reference));
	}
	private readonly runtime: FakeRuntimeCoordinator;
	private readonly clock: () => number;
	private readonly recipientIdentity: string | undefined;
	private held?: {
		received: PromiseWithResolvers<void>;
		committed: PromiseWithResolvers<void>;
		response: PromiseWithResolvers<AdmissionCommit>;
		proposal?: AdmissionProposal;
		result?: AdmissionCommit;
		done: boolean;
	};
	constructor(
		runtime: FakeRuntimeCoordinator,
		clock: () => number = Date.now,
		image?: RequestRecoveryImage,
		recipientIdentity?: string,
	) {
		this.runtime = runtime;
		this.clock = clock;
		this.recipientIdentity = recipientIdentity;
		this.coordination = new FakeCoordinationState(
			clock,
			(ref) => {
				const event = this.events.get(this.key(ref));
				return (
					event !== undefined &&
					event.state === "pending" &&
					(event.expiresAt === null || event.expiresAt > this.clock())
				);
			},
			(ref) => {
				const event = this.events.get(this.key(ref));
				return event !== undefined && event.state === "read";
			},
			(requesterMailbox, subscriptionId, watchedInstanceId, reason, _recordedAt) => {
				const event = this.seedEvent(
					`idle-${subscriptionId}`,
					canonicalJson({
						subscriptionId,
						watchedInstanceId,
						reason,
					}),
					null,
					requesterMailbox,
				);
				return { recipientIdentity: event.recipientIdentity, eventId: event.eventId };
			},
			image?.coordination,
		);
		if (image) {
			for (const event of image.events) this.events.set(this.key(event.canonical), structuredClone(event));
			for (const request of image.requests) this.requests.set(request.result.requestId, structuredClone(request));
			this.consumption = new Map(image.consumption);
			this.revision = image.revision;
		}
	}
	private assertRequest(request: AdmissionRequest): void {
		this.runtime.assertCurrentFence(request.fence);
		const attachment = this.runtime.attachmentFor(request.fence.mailboxId);
		if (!attachment || canonicalJson(attachment.conversation) !== canonicalJson(request.conversation))
			throw new Error("Conversation does not match runtime fence");
	}
	private key(reference: { recipientIdentity: string; eventId: string }): string {
		return canonicalJson([reference.recipientIdentity, reference.eventId]);
	}
	private view(conversation: ConversationBinding): ExternalEventRefresh {
		return {
			sessionId: conversation.piSessionId,
			revision: this.revision,
			verified: true,
			events: [...this.events.values()]
				.filter((event) => event.canonical.recipientIdentity === this.runtime.mailboxFor(conversation))
				.map((event) => ({
					recipientIdentity: event.canonical.recipientIdentity,
					eventId: event.canonical.eventId,
					state: event.state,
					expiresAt: event.expiresAt,
					reason: null,
				})),
		};
	}
	seedEvent(
		eventId: string,
		body: string,
		expiresAt: number | null = null,
		recipientIdentity = this.recipientIdentity,
	): CanonicalEvent {
		if (!recipientIdentity) throw new Error("Seed recipient is required");
		const event = { ...canonical(eventId, body), recipientIdentity };
		const key = this.key(event);
		if (this.events.has(key)) throw new Error("Event already exists");
		this.events.set(key, {
			canonical: event,
			expiresAt,
			state: "pending",
			deliveredAt: null,
			readAt: null,
			receipt: null,
		});
		this.revision++;
		return structuredClone(event);
	}
	dropEvent(reference: { recipientIdentity: string; eventId: string }): void {
		const event = this.events.get(this.key(reference));
		if (!event) throw new Error("Unknown event");
		event.state = "dropped";
		this.revision++;
	}
	seedMatchingConsumption(reference: { recipientIdentity: string; eventId: string }, target: string): void {
		this.consumption.set(this.key(reference), target);
	}
	inspectConsumption(reference: { recipientIdentity: string; eventId: string }): string | null | undefined {
		return this.consumption.get(this.key(reference));
	}
	inspectEvent(reference: { recipientIdentity: string; eventId: string }): Event | undefined {
		const event = this.events.get(this.key(reference));
		return event && structuredClone(event);
	}
	inspectRequest(id: string): StoredRequest | undefined {
		const result = this.requests.get(id);
		return result && structuredClone(result);
	}
	exportRecoveryImage(): RequestRecoveryImage {
		return structuredClone({
			events: [...this.events.values()],
			requests: [...this.requests.values()],
			consumption: [...this.consumption],
			coordination: this.coordination.exportRecoveryImage(),
			revision: this.revision,
		});
	}
	async snapshot(request: AdmissionRequest, signal?: AbortSignal): Promise<AdmissionSnapshot> {
		signal?.throwIfAborted();
		this.assertRequest(request);
		const candidates: AdmissionSnapshot["candidates"][number][] = [];
		const dispositions: RequestDisposition[] = [];
		const seen = new Set<string>();
		const now = this.clock();
		for (const event of this.events.values()) {
			if (
				event.canonical.recipientIdentity !== request.fence.mailboxId ||
				(this.omittedCandidates.has(this.key(event.canonical)) &&
					!request.references.some((reference) => this.key(reference) === this.key(event.canonical))) ||
				event.state !== "pending" ||
				(event.expiresAt !== null && event.expiresAt <= now)
			)
				continue;
			candidates.push({
				canonical: structuredClone(event.canonical),
				expiresAt: event.expiresAt,
				workspaceBasis: this.eventBasis.get(this.key(event.canonical)),
			});
			seen.add(this.key(event.canonical));
		}
		for (const reference of request.references) {
			const key = this.key(reference);
			if (seen.has(key)) continue;
			seen.add(key);
			const event = reference.recipientIdentity === request.fence.mailboxId ? this.events.get(key) : undefined;
			if (!event) {
				dispositions.push({ ...reference, code: "unavailable", reason: "unknown event" });
				continue;
			}
			const code = event.state === "read" ? "already-read" : event.state === "dropped" ? "dropped" : "expired";
			dispositions.push({ ...reference, code, reason: code });
		}
		return { candidates, dispositions, view: this.view(request.conversation) };
	}
	async delivered(request: AdmissionRequest, receipts: readonly EntryReceipt[], signal?: AbortSignal): Promise<void> {
		signal?.throwIfAborted();
		this.assertRequest(request);
		const manager = SessionManager.open(request.conversation.sessionFile);
		if (manager.getSessionId() !== request.conversation.piSessionId) throw new Error("Session identity mismatch");
		const verified: Array<{ event: Event; receipt: EntryReceipt }> = [];
		for (const receipt of receipts) {
			const event = [...this.events.values()].find((item) => recordKey(item.canonical) === receipt.key);
			const actual = manager.getEntryOnce(receipt.key);
			if (
				!event ||
				!actual ||
				event.canonical.recipientIdentity !== request.fence.mailboxId ||
				actual.sessionId !== receipt.sessionId ||
				actual.entryId !== receipt.entryId ||
				actual.key !== receipt.key ||
				realpathSync(actual.sessionFile) !== realpathSync(receipt.sessionFile)
			)
				throw new Error("Invalid canonical receipt");
			const stored = manager.getEntry(receipt.entryId);
			if (!stored || stored.type !== "custom" || canonicalJson(stored.data) !== canonicalJson(event.canonical))
				throw new Error("Canonical record mismatch");
			verified.push({ event, receipt });
		}
		for (const item of verified) {
			item.event.receipt = structuredClone(item.receipt);
			item.event.deliveredAt ??= this.clock();
		}
	}
	async workspace(request: AdmissionRequest, signal?: AbortSignal): Promise<WorkspaceSnapshot> {
		signal?.throwIfAborted();
		this.assertRequest(request);
		const snapshot = structuredClone(this.workspaceState);
		this.requestBasis.set(request.requestId, snapshot);
		return snapshot;
	}
	private fingerprint(proposal: AdmissionProposal): string {
		const {
			connectionId: _id,
			connectionRevision: _connection,
			verificationRevision: _verification,
			...fence
		} = proposal.request.fence;
		return createHash("sha256")
			.update(canonicalJson({ ...proposal, request: { ...proposal.request, fence } }))
			.digest("hex");
	}
	private commit(proposal: AdmissionProposal): AdmissionCommit {
		this.assertRequest(proposal.request);
		const fingerprint = this.fingerprint(proposal);
		const old = this.requests.get(proposal.request.requestId);
		if (old) {
			if (old.fingerprint !== fingerprint) throw new Error("Conflicting request proposal");
			return structuredClone(old.result);
		}
		const seen = new Set<string>();
		const ids = new Set<string>();
		const manager = SessionManager.open(proposal.request.conversation.sessionFile);
		if (manager.getSessionId() !== proposal.request.conversation.piSessionId)
			throw new Error("Session identity mismatch");
		if (proposal.request.branchAnchor !== null && !manager.getEntry(proposal.request.branchAnchor))
			throw new Error("Admission root anchor not found");
		const recipient = proposal.selected[0]?.event.recipientIdentity;
		const physicalIds = new Set(
			readStrictSession(proposal.request.conversation.sessionFile, "readonly").flatMap((entry) =>
				typeof entry === "object" &&
				entry !== null &&
				"type" in entry &&
				entry.type !== "session" &&
				"id" in entry &&
				typeof entry.id === "string"
					? [entry.id]
					: [],
			),
		);
		for (const item of proposal.selected) {
			const key = this.key(item.event);
			const event = this.events.get(key);
			if (
				!event ||
				item.event.recipientIdentity !== recipient ||
				item.event.recipientIdentity !== proposal.request.fence.mailboxId ||
				seen.has(key) ||
				!item.entryId ||
				ids.has(item.entryId) ||
				physicalIds.has(item.entryId) ||
				canonicalJson(event.canonical) !== canonicalJson(item.event) ||
				!event.receipt ||
				canonicalJson(event.receipt) !== canonicalJson(item.receipt)
			)
				throw new Error("Invalid selected event or canonical receipt");
			const actual = manager.getEntryOnce(item.receipt.key);
			const stored = manager.getEntry(item.receipt.entryId);
			if (
				!actual ||
				actual.entryId !== item.receipt.entryId ||
				actual.sessionId !== item.receipt.sessionId ||
				realpathSync(actual.sessionFile) !== realpathSync(item.receipt.sessionFile) ||
				!stored ||
				stored.type !== "custom" ||
				canonicalJson(stored.data) !== canonicalJson(event.canonical)
			)
				throw new Error("Canonical receipt no longer valid");
			seen.add(key);
			ids.add(item.entryId);
		}
		const claim = proposal.request.activation;
		if (claim) {
			const instanceKey = `${proposal.request.fence.mailboxId}:${proposal.request.fence.instanceId}`;
			const floor = this.coordination.getMinimumPermissionEpoch(instanceKey);
			if (
				claim.instanceId !== proposal.request.fence.instanceId ||
				claim.runtimeEpoch !== proposal.request.fence.epoch ||
				claim.permissionEpoch < floor
			) {
				throw new Error("Activation scope does not match runtime fence");
			}
			const proposedKeys = new Set(proposal.selected.map((item) => eventKey(item.event)));
			if (!claim.targets.some((target) => proposedKeys.has(eventKey(target.event)))) {
				throw new Error("Wake proposal has no claimed target");
			}
		}

		const now = this.clock();
		const timestamp = new Date(now).toISOString();
		let anchor = proposal.request.branchAnchor;
		const entries: AdmissionCommit["entries"][number][] = [];
		const dispositions = [...proposal.dispositions];
		const eventsToRead: Array<{ event: Event; entryId: string }> = [];

		for (const item of proposal.selected) {
			const event = this.events.get(this.key(item.event))!;
			const code =
				event.state === "read"
					? "already-read"
					: event.state === "dropped"
						? "dropped"
						: event.state === "expired" || (event.expiresAt !== null && event.expiresAt <= now)
							? "expired"
							: undefined;
			if (code) {
				if (code === "expired") event.state = "expired";
				dispositions.push({
					recipientIdentity: item.event.recipientIdentity,
					eventId: item.event.eventId,
					code,
					reason: code,
				});
				continue;
			}
			entries.push({
				entryId: item.entryId,
				timestamp,
				record: {
					...item.event,
					kind: "admission",
					envelope: item.envelope,
					requestId: proposal.request.requestId,
					instanceId: proposal.request.fence.instanceId,
					epoch: proposal.request.fence.epoch,
					branchAnchor: anchor,
				},
			});
			anchor = item.entryId;
			eventsToRead.push({ event, entryId: item.entryId });
		}

		const activeGrants = claim
			? this.coordination.getActiveGrants(
					proposal.request.fence.mailboxId,
					proposal.request.fence.instanceId,
					claim.runtimeEpoch,
					claim.permissionEpoch,
				)
			: this.coordination.getActiveGrants(
					proposal.request.fence.mailboxId,
					proposal.request.fence.instanceId,
					proposal.request.fence.epoch,
				);

		let admittedKeys = new Set(entries.map((entry) => eventKey(entry.record)));
		const hasAuthorizedTarget =
			!claim ||
			claim.targets.some(
				(target) =>
					admittedKeys.has(eventKey(target.event)) &&
					activeGrants.some(
						(grant) =>
							grant.grantId === target.grantId &&
							grant.event !== undefined &&
							eventKey(grant.event) === eventKey(target.event),
					),
			);

		if (!hasAuthorizedTarget) {
			for (const entry of entries) {
				dispositions.push({
					recipientIdentity: entry.record.recipientIdentity,
					eventId: entry.record.eventId,
					code: "unavailable",
					reason: "Wake target unavailable; event retained for an authorized request",
				});
			}
			entries.length = 0;
			eventsToRead.length = 0;
			admittedKeys = new Set();
		}

		const matchingGrants = activeGrants.filter(
			(grant) => grant.event !== undefined && admittedKeys.has(eventKey(grant.event)),
		);

		for (const { event } of eventsToRead) {
			event.state = "read";
			event.readAt = now;
			event.deliveredAt ??= now;
			if (this.consumption.has(this.key(event.canonical))) {
				this.consumption.set(this.key(event.canonical), null);
			}
		}

		for (const grant of matchingGrants) {
			grant.state = "consumed";
			this.coordination.markConsumed(
				proposal.request.fence.mailboxId,
				proposal.request.fence.instanceId,
				grant.target,
			);
		}

		this.revision++;
		const consumedGrantIds = matchingGrants.map((grant) => grant.grantId);
		const result: AdmissionCommit = {
			requestId: proposal.request.requestId,
			entries,
			dispositions,
			view: this.view(proposal.request.conversation),
			...(consumedGrantIds.length > 0 ? { consumedGrantIds } : {}),
		};
		const {
			connectionId: _connectionId,
			connectionRevision: _connectionRevision,
			verificationRevision: _verificationRevision,
			generationToken,
			...durableFence
		} = proposal.request.fence;
		const storedProposal: StoredProposal = {
			...proposal,
			request: {
				...proposal.request,
				fence: {
					...durableFence,
					generationTokenDigest: createHash("sha256").update(generationToken).digest("hex"),
				},
			},
		};
		this.requests.set(result.requestId, {
			fingerprint,
			proposal: structuredClone(storedProposal),
			conversation: structuredClone(proposal.request.conversation),
			result: structuredClone(result),
			suppressed: false,
		});
		return structuredClone(result);
	}
	async admit(proposal: AdmissionProposal, signal?: AbortSignal): Promise<AdmissionCommit> {
		signal?.throwIfAborted();
		this.assertRequest(proposal.request);
		const gate = this.held;
		if (!gate) return this.commit(proposal);
		this.held = undefined;
		gate.proposal = structuredClone(proposal);
		gate.received.resolve();
		return gate.response.promise;
	}
	holdNextAdmission(): HeldAdmission {
		if (this.held) throw new Error("Admission already held");
		const gate = {
			received: Promise.withResolvers<void>(),
			committed: Promise.withResolvers<void>(),
			response: Promise.withResolvers<AdmissionCommit>(),
			proposal: undefined as AdmissionProposal | undefined,
			result: undefined as AdmissionCommit | undefined,
			done: false,
		};
		void gate.committed.promise.catch(() => {});
		this.held = gate;
		return {
			received: gate.received.promise,
			committed: gate.committed.promise,
			commit: () => {
				if (!gate.proposal || gate.done) throw new Error("Admission not ready");
				gate.done = true;
				try {
					gate.result = this.commit(gate.proposal);
					gate.committed.resolve();
				} catch (error) {
					gate.committed.reject(error);
					gate.response.reject(error);
				}
			},
			respond: () => {
				if (!gate.result) throw new Error("Admission not committed");
				gate.response.resolve(structuredClone(gate.result));
			},
			rejectResponse: (error) => gate.response.reject(error),
		};
	}
	async lookup(requestId: string): Promise<AdmissionCommit | undefined> {
		const result = this.requests.get(requestId)?.result;
		return result && structuredClone(result);
	}
	async recover(conversation: ConversationBinding): Promise<AdmissionRecovery> {
		const mailbox = this.runtime.mailboxFor(conversation);
		const attachment = mailbox && this.runtime.attachmentFor(mailbox);
		if (!mailbox || !attachment || canonicalJson(attachment.conversation) !== canonicalJson(conversation))
			throw new Error("Recovery requires the current mailbox attachment");
		return {
			commits: [...this.requests.values()]
				.filter(
					(request) =>
						request.proposal.request.fence.mailboxId === mailbox &&
						canonicalJson(request.conversation) === canonicalJson(conversation),
				)
				.map((request) => structuredClone(request.result)),
			view: this.view(conversation),
		};
	}
	async suppressed(requestId: string): Promise<void> {
		const request = this.requests.get(requestId);
		if (request) request.suppressed = true;
	}

	async wait(operation: WaitOperation, signal?: AbortSignal): Promise<WaitOutcome> {
		signal?.throwIfAborted();
		this.runtime.assertCurrentFence(operation.scope.fence);
		return this.coordination.wait(operation, signal);
	}

	async grant(operation: GrantOperation, signal?: AbortSignal): Promise<GrantReceipt> {
		signal?.throwIfAborted();
		this.runtime.assertCurrentFence(operation.scope.fence);
		return this.coordination.grant(operation, signal);
	}

	async permissions(scope: PermissionScope, signal?: AbortSignal): Promise<PermissionSnapshot> {
		signal?.throwIfAborted();
		this.runtime.assertCurrentFence(scope.fence);
		return this.coordination.permissions(scope, signal);
	}

	async cancelPermissions(operation: PermissionCancellation): Promise<void> {
		const canRevoke = this.runtime.canRevokePermissions(operation.scope.fence);
		this.coordination.cancelPermissions(operation, canRevoke);
	}
}
