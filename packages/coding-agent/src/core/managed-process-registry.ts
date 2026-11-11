import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readLocalProcessBirth } from "./managed-process-birth.ts";
import type { ManagedAttempt, ManagedCallContext } from "./managed-process-context.ts";
import type {
	AcknowledgedAttemptImage,
	AttemptIntent,
	AttemptJournalTarget,
	CleanupReceipt,
	CoverageReason,
	JournalRecord,
	ManagedProcessAdapter,
	ProcessAuthentication,
	ProcessGap,
	ProcessJournalEntry,
	ProcessJournalPage,
	RegistrationReceipt,
	SpawnIntent,
} from "./managed-process-types.ts";
import type { RuntimeFence } from "./runtime-lifecycle-types.ts";

export class ManagedProcessRegistry {
	readonly contexts = new AsyncLocalStorage<ManagedCallContext | undefined>();
	readonly attempts = new Map<string, ManagedAttempt>();
	private entries = new Map<string, ProcessJournalEntry>();
	private observations = new Map<string, RegistrationReceipt>();
	private records = new Map<string, JournalRecord>();
	private tombstones = new Map<string, { intent: SpawnIntent; revision: number; sequence: number }>();
	private revisions = new Map<string, number>();
	private sequence = 0;
	private reconciledThrough = 0;
	private overflow = 0;
	private readonly attemptVersions = new Map<string, number>();
	private readonly acknowledgedAttempts = new Map<string, AcknowledgedAttemptImage>();
	private replay?: { pages: ProcessJournalPage[]; index: number; versions: Map<string, number> };
	private reconciling?: Promise<void>;
	get through(): number {
		return this.sequence;
	}
	get accepting(): boolean {
		return !this.overflow && this.entries.size < 4096;
	}
	private put(key: string, record: JournalRecord): void {
		if (this.sequence === Number.MAX_SAFE_INTEGER) throw new Error("Process journal counter exhausted");
		const revision = ++this.sequence;
		record.sequence = this.records.get(key)?.sequence ?? revision;
		if (record.kind === "spawn") record.value.sequence = record.sequence;
		this.records.set(key, structuredClone(record));
		const attemptId = record.kind === "spawn" ? record.value.intent.attemptId : record.value.attemptId;
		this.attemptVersions.set(attemptId, revision);
	}
	private saveAttempt(attempt: ManagedAttempt): void {
		const key = `attempt:${attempt.intent.attemptId}`;
		const value = { ...attempt.intent, ended: attempt.ended, stopping: attempt.stopping };
		const previous = this.records.get(key);
		if (previous?.kind === "attempt" && JSON.stringify(previous.value) === JSON.stringify(value)) return;
		// A finite image retains the latest state at its original creation ordinal.
		this.put(key, { sequence: 0, kind: "attempt", value });
	}
	begin(intent: AttemptIntent, fence: RuntimeFence | undefined, adapter: ManagedProcessAdapter): ManagedAttempt {
		if (this.attempts.has(intent.attemptId)) throw new Error("Attempt identity already used");
		intent = structuredClone(intent);
		Object.freeze(intent.provenance.conversation);
		Object.freeze(intent.provenance);
		Object.freeze(intent);
		if (fence) fence = Object.freeze({ ...fence });
		const attempt: ManagedAttempt = {
			intent,
			fence,
			adapter,
			registry: this,
			stopping: false,
			retired: false,
			ended: false,
			opening: Promise.resolve(),
			activities: new Set(),
			cancellations: new Set(),
			gates: new Set(),
			state: new Map(),
		};
		this.attempts.set(intent.attemptId, attempt);
		this.saveAttempt(attempt);
		// Allocate and retain before the first possible transport await.
		attempt.opening = Promise.resolve().then(async () => {
			if (!fence) throw new Error("Runtime attachment unavailable");
			const result = await adapter.open(intent, fence);
			// Adapter wire response trust boundary.
			if (result.attemptId !== intent.attemptId || result.marker !== intent.marker)
				throw new Error("Process authority changed immutable attempt identity");
		});
		void attempt.opening.catch(() => {
			this.gap({ attempt, source: "extension", toolCallId: intent.attemptId }, "registration-outage");
		});
		return attempt;
	}
	end(attempt: ManagedAttempt): void {
		attempt.ended = true;
		this.saveAttempt(attempt);
	}
	attemptState(attemptId: string): Map<string, unknown> {
		const attempt = this.attempts.get(attemptId);
		if (!attempt) throw new Error("Unknown managed attempt");
		return attempt.state;
	}
	record(
		intent: SpawnIntent,
		context: ManagedCallContext,
		localBirth: string | null,
	): ProcessJournalEntry | undefined {
		if (
			intent.attemptId !== context.attempt.intent.attemptId ||
			intent.marker !== context.attempt.intent.marker ||
			intent.toolCallId !== context.toolCallId ||
			intent.source !== context.source
		)
			throw new Error("Spawn context changed");
		intent = Object.freeze({ ...intent });
		const old = this.entries.get(intent.spawnId);
		const tombstone = this.tombstones.get(intent.spawnId);
		if (old || tombstone) {
			if (JSON.stringify((old ?? tombstone)!.intent) !== JSON.stringify(intent))
				throw new Error("Spawn identity conflict");
			return old;
		}
		if (!this.accepting) {
			this.overflow++;
			this.gap(context, "journal-overflow");
			return undefined;
		}
		const entry: ProcessJournalEntry = {
			sequence: 0,
			intent,
			provenance: context.attempt.intent.provenance,
			localBirth,
			released: false,
			callEnded: false,
			aborted: false,
			gaps: [],
		};
		this.entries.set(intent.spawnId, entry);
		this.update(entry);
		return entry;
	}
	private update(entry: ProcessJournalEntry): void {
		this.put(`spawn:${entry.intent.spawnId}`, { sequence: 0, kind: "spawn", value: entry });
	}
	registered(receipt: RegistrationReceipt, entry: ProcessJournalEntry): void {
		if (
			receipt.spawnId !== entry.intent.spawnId ||
			receipt.root.pid !== entry.intent.pid ||
			receipt.root.pgid !== entry.intent.pgid ||
			receipt.root.sid !== entry.intent.pid ||
			!/^kinfo:\d+$/.test(receipt.root.birth) ||
			!Number.isSafeInteger(receipt.revision) ||
			receipt.revision < 0
		)
			throw new Error("Invalid managed registration receipt");
		this.observations.set(receipt.spawnId, receipt);
		// A late response never removes a released-unwatched interval.
	}
	released(entry: ProcessJournalEntry): void {
		entry.released = true;
		this.update(entry);
	}
	spawnGap(entry: ProcessJournalEntry, context: ManagedCallContext, reason: CoverageReason): void {
		if (!entry.gaps.includes(reason)) {
			entry.gaps.push(reason);
			this.update(entry);
		}
		this.gap(context, reason);
	}
	gap(context: ManagedCallContext, reason: CoverageReason): void {
		const { attempt, toolCallId, source } = context;
		const key = `gap:${attempt.intent.attemptId}:${toolCallId}:${source}:${reason}`;
		if (this.records.has(key)) return;
		const value: ProcessGap = {
			operationId: randomUUID(),
			attemptId: attempt.intent.attemptId,
			toolCallId,
			source,
			reason,
		};
		this.put(key, { sequence: 0, kind: "gap", value });
		if (attempt.fence) void attempt.adapter.coverage(value, attempt.fence).catch(() => {});
	}
	callEnded(entry: ProcessJournalEntry | undefined, context: ManagedCallContext, aborted: boolean): void {
		if (!entry || entry.callEnded) return;
		entry.callEnded = true;
		entry.aborted = aborted;
		this.update(entry);
		const fence = context.attempt.fence;
		if (fence)
			void context.attempt.adapter
				.callEnd(
					{
						operationId: randomUUID(),
						attemptId: entry.intent.attemptId,
						spawnId: entry.intent.spawnId,
						aborted,
					},
					fence,
				)
				.catch(() => {});
	}
	retireRuntime(instanceId: string): void {
		for (const attempt of this.attempts.values()) {
			if (attempt.intent.provenance.instanceId !== instanceId) continue;
			attempt.retired = true;
			for (const cancel of [...attempt.gates]) cancel();
		}
	}
	requestStop(
		attemptId: string,
		stopId: string,
		abortRun: () => Promise<void>,
	): { requested: true; settled: Promise<void> } {
		const attempt = this.attempts.get(attemptId);
		if (!attempt) throw new Error("Stop target is not retained by this host");
		// Service stop IDs identify separate confirmed control/receipt rounds, not new local aborts.
		// Reuse the attempt's latch for same-ID retries and a later confirmed retry after uncertainty.
		if (attempt.stop) return { requested: true, settled: attempt.stop.settled };
		attempt.stopping = true;
		this.saveAttempt(attempt);
		const settled = Promise.resolve()
			.then(abortRun)
			.then(async () => {
				while (attempt.activities.size) await Promise.all([...attempt.activities]);
				this.end(attempt);
			});
		// Latch the shared promise before synchronous cancellation callbacks can reenter requestStop.
		attempt.stop = { id: stopId, settled };
		void settled.catch(() => {});
		for (const cancel of [...attempt.gates]) cancel();
		for (const cancel of [...attempt.cancellations]) cancel();
		return { requested: true, settled };
	}
	accounted(receipt: CleanupReceipt): void {
		if (!this.attempts.has(receipt.attemptId) || !Number.isSafeInteger(receipt.revision) || receipt.revision < 0)
			throw new Error("Invalid cleanup receipt");
		if (new Set(receipt.spawnIds).size !== receipt.spawnIds.length) throw new Error("Duplicate cleanup spawn");
		for (const id of receipt.spawnIds) {
			const intent = (this.entries.get(id) ?? this.tombstones.get(id))?.intent;
			if (!intent || intent.attemptId !== receipt.attemptId) throw new Error("Foreign cleanup spawn");
		}
		for (const id of receipt.spawnIds) {
			if (receipt.revision <= (this.revisions.get(id) ?? -1)) continue;
			this.revisions.set(id, receipt.revision);
			if (receipt.verdict !== "accounted") continue;
			const entry = this.entries.get(id);
			if (!entry) continue;
			this.entries.delete(id);
			this.records.delete(`spawn:${id}`);
			this.observations.delete(id);
			this.tombstones.set(id, { intent: entry.intent, revision: receipt.revision, sequence: ++this.sequence });
		}
	}
	snapshot() {
		return {
			entries: structuredClone([...this.entries.values()]),
			tombstones: structuredClone([...this.tombstones.values()]),
			through: this.sequence,
		};
	}
	inspect() {
		const gaps = [...new Set([...this.records.values()].flatMap((r) => (r.kind === "gap" ? [r.value.reason] : [])))];
		return {
			pending: this.entries.size,
			gaps,
			stopping: [...this.attempts.values()].some((a) => a.stopping),
			through: this.sequence,
			reconciledThrough: this.reconciledThrough,
		};
	}
	private pages(): ProcessJournalPage[] {
		const through = this.sequence;
		const records = structuredClone(
			[...this.records.values()].filter((r) => r.sequence <= through).sort((a, b) => a.sequence - b.sequence),
		);
		const pages: ProcessJournalPage[] = [];
		let after = 0;
		while (records.length) {
			const page: ProcessJournalPage = { operationId: randomUUID(), after, through, complete: false, records: [] };
			while (records.length && page.records.length < 32) {
				const next = records[0];
				if (Buffer.byteLength(JSON.stringify({ ...page, records: [...page.records, next] })) > 240 * 1024) {
					if (!page.records.length) throw new Error("Oversized process journal record");
					break;
				}
				page.records.push(records.shift()!);
			}
			after = page.records.at(-1)!.sequence;
			pages.push(page);
		}
		if (!pages.length) pages.push({ operationId: randomUUID(), after: 0, through, complete: true, records: [] });
		pages[pages.length - 1].complete = true;
		return pages;
	}
	captureAttemptVersion(attemptId: string): AttemptJournalTarget {
		const version = this.attemptVersions.get(attemptId);
		if (version === undefined) throw new Error("Unknown managed attempt");
		return Object.freeze({ attemptId, version });
	}
	async reconcileAttempt(
		target: AttemptJournalTarget,
		adapter: ManagedProcessAdapter,
		auth: ProcessAuthentication,
	): Promise<AcknowledgedAttemptImage> {
		const retained = this.attemptVersions.get(target.attemptId);
		if (
			retained === undefined ||
			!Number.isSafeInteger(target.version) ||
			target.version < 1 ||
			target.version > retained
		)
			throw new Error("Invalid attempt journal target");
		for (;;) {
			const covered = this.acknowledgedAttempts.get(target.attemptId);
			if (covered && covered.version >= target.version) return Object.freeze({ ...covered });
			// An older retry is drained first. A later finite image covers this target even if siblings keep changing.
			await this.reconcile(adapter, auth);
		}
	}
	reconcile(adapter: ManagedProcessAdapter, auth: ProcessAuthentication): Promise<void> {
		if (this.reconciling) return this.reconciling;
		const run = async () => {
			await adapter.proveHost(auth, () => readLocalProcessBirth(process.pid));
			this.replay ??= { pages: this.pages(), index: 0, versions: new Map(this.attemptVersions) };
			const replay = this.replay;
			while (replay.index < replay.pages.length) {
				const page = replay.pages[replay.index];
				const result = await adapter.reconcile(page, auth);
				if (result.acknowledgedThrough !== (page.complete ? page.through : page.records.at(-1)!.sequence))
					throw new Error("Invalid journal acknowledgement");
				if (page.complete) {
					this.reconciledThrough = Math.max(this.reconciledThrough, page.through);
					for (const [attemptId, version] of replay.versions) {
						const old = this.acknowledgedAttempts.get(attemptId);
						if (!old || old.version <= version)
							this.acknowledgedAttempts.set(attemptId, { attemptId, version, through: page.through });
					}
				}
				for (const receipt of result.cleanup) this.accounted(receipt);
				replay.index++;
			}
			// Do not compact unresolved identities or gaps using a replay watermark.
			// Tombstones remain immutable deduplication receipts for this host lifetime.
			this.replay = undefined;
		};
		this.reconciling = run().finally(() => {
			this.reconciling = undefined;
		});
		return this.reconciling;
	}
}
