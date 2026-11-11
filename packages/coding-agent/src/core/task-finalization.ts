/**
 * Process-owned bookkeeping of managed tasks: which attempt is a conversation's current task, whether its stop
 * or end has latched, and the full-batch certificate waiting for the process authority.
 */

export interface BatchCertificate {
	operationId: string;
	attemptId: string;
	runId: string;
	registryThrough: number;
	claim: "claimed-success" | "claimed-failure";
	declarationToolCallId: string;
	toolResults: { toolCallId: string; isError: boolean }[];
	declarationBeforeResults: boolean;
}

/** A task's declaration that the tool call `declarationToolCallId` ends it, staged until its batch completes. */
export interface FinalizationDeclaration {
	operationId: string;
	claim: BatchCertificate["claim"];
	declarationToolCallId: string;
}

export interface FinalizationBinding {
	attemptId: string;
	runId: string;
	/** Produced by `conversationKeyOf()` from the runtime's resolved conversation binding. */
	conversationKey: string;
	kind: "inline" | "helper";
}

/**
 * The key under which a conversation's tasks are bound. Derive it from the conversation binding the runtime
 * resolved (its session file is a real path), never from the session manager's own path, which can differ.
 */
export function conversationKeyOf(conversation: { piSessionId: string; sessionFile: string }): string {
	return JSON.stringify([conversation.piSessionId, conversation.sessionFile]);
}

interface Attempt {
	binding: FinalizationBinding;
	stopping: boolean;
	ended: boolean;
	pending?: FinalizationDeclaration;
	certificate?: BatchCertificate;
}

export type FinalizationCommit = (certificate: BatchCertificate) => Promise<"committed" | "superseded">;

/** Owned once by RuntimeHost, never by an extension or replaceable AgentSession. */
export class TaskFinalizationBook {
	private readonly attempts = new Map<string, Attempt>();
	private readonly selected = new Map<string, string>();
	private readonly reconciliations = new Map<string, Promise<void>>();
	private readonly stateFor?: (attemptId: string) => Map<string, unknown>;
	constructor(stateFor?: (attemptId: string) => Map<string, unknown>) {
		this.stateFor = stateFor;
	}
	/** Makes `binding` its conversation's current task. A stopped or ended attempt never reopens. */
	bind(binding: FinalizationBinding): void {
		const old = this.attempts.get(binding.attemptId);
		if (old && (old.binding.conversationKey !== binding.conversationKey || old.binding.kind !== binding.kind))
			throw new Error("attempt binding conflict");
		if (old?.ended || old?.stopping) throw new Error("terminal attempt cannot reopen");
		if (old?.pending && old.binding.runId !== binding.runId)
			throw new Error("pending declaration belongs to another run");
		if (old) old.binding = binding;
		else {
			const attempt: Attempt = { binding, stopping: false, ended: false };
			// First, so an attempt the process registry does not retain leaves no trace here.
			this.stateFor?.(binding.attemptId).set("task-finalization", attempt);
			this.attempts.set(binding.attemptId, attempt);
		}
		this.selected.set(binding.conversationKey, binding.attemptId);
	}
	current(conversationKey: string): FinalizationBinding | undefined {
		const id = this.selected.get(conversationKey);
		return id ? this.attempts.get(id)?.binding : undefined;
	}
	/**
	 * Whether automatic work of the conversation has ended. A helper task ends permanently, whatever is selected or
	 * active. A stopped or ended inline task suppresses only its own exact active run, never a later wake.
	 */
	blocks(conversationKey: string, active?: FinalizationBinding): boolean {
		for (const attempt of this.attempts.values())
			if (
				attempt.binding.conversationKey === conversationKey &&
				attempt.binding.kind === "helper" &&
				(attempt.ended || attempt.stopping)
			)
				return true;
		if (!active || active.conversationKey !== conversationKey || active.kind !== "inline") return false;
		const attempt = this.attempts.get(active.attemptId);
		return (
			!!attempt &&
			attempt.binding.kind === active.kind &&
			attempt.binding.conversationKey === conversationKey &&
			attempt.binding.runId === active.runId &&
			(attempt.ended || attempt.stopping)
		);
	}
	stage(binding: FinalizationBinding, declaration: FinalizationDeclaration): void {
		const attempt = this.exact(binding);
		if (attempt.ended || attempt.stopping || attempt.pending)
			throw new Error("finalization is already staged or ended");
		attempt.pending = declaration;
	}
	/** Latches a service stop. It outranks any staged declaration, which is dropped. */
	stop(attemptId: string): void {
		const attempt = this.attempts.get(attemptId);
		if (!attempt) return;
		attempt.stopping = true;
		attempt.pending = undefined;
	}
	cancel(binding: FinalizationBinding): void {
		this.exact(binding).pending = undefined;
	}
	/** The latch and outbox are set synchronously before invoking transport. */
	boundary(
		binding: FinalizationBinding,
		input: {
			aborted: boolean;
			assistantError?: boolean;
			registryThrough: number | (() => number);
			toolResults: BatchCertificate["toolResults"];
		},
	): boolean {
		const attempt = this.exact(binding);
		if (input.aborted || input.assistantError || attempt.stopping) {
			attempt.pending = undefined;
			return attempt.stopping;
		}
		if (new Set(input.toolResults.map((result) => result.toolCallId)).size !== input.toolResults.length) {
			attempt.pending = undefined;
			return false;
		}
		if (attempt.ended) return true;
		const pending = attempt.pending;
		if (!pending) return false;
		const declaration = input.toolResults.find((result) => result.toolCallId === pending.declarationToolCallId);
		if (!declaration || declaration.isError) {
			attempt.pending = undefined;
			return false;
		}
		attempt.ended = true;
		attempt.pending = undefined;
		attempt.certificate = {
			operationId: pending.operationId,
			attemptId: binding.attemptId,
			runId: binding.runId,
			// Preserve the helper's claim; sibling failures are observations, not a verdict.
			claim: pending.claim,
			declarationToolCallId: pending.declarationToolCallId,
			registryThrough: typeof input.registryThrough === "function" ? input.registryThrough() : input.registryThrough,
			toolResults: structuredClone(input.toolResults),
			declarationBeforeResults: input.toolResults.some(
				(result) => result.toolCallId !== pending.declarationToolCallId,
			),
		};
		for (const result of attempt.certificate.toolResults) Object.freeze(result);
		Object.freeze(attempt.certificate.toolResults);
		Object.freeze(attempt.certificate);
		return true;
	}
	/** The certificate still waiting for the process authority, if any. */
	pending(attemptId: string): BatchCertificate | undefined {
		return this.attempts.get(attemptId)?.certificate;
	}
	/** Failed transport leaves the same certificate and ended latch in the process book. */
	reconcile(attemptId: string, commit: FinalizationCommit): Promise<void> {
		const old = this.reconciliations.get(attemptId);
		if (old) return old;
		const operation = (async () => {
			const attempt = this.attempts.get(attemptId);
			const certificate = attempt?.certificate;
			if (!attempt || !certificate) return;
			const disposition = await commit(certificate);
			// Adapter wire response trust boundary.
			if (disposition !== "committed" && disposition !== "superseded")
				throw new Error("Unrecognized finalization receipt");
			// A superseded service winner consumes the outbox without claiming the requested outcome.
			if (attempt.certificate === certificate) attempt.certificate = undefined;
		})();
		this.reconciliations.set(attemptId, operation);
		void operation
			.finally(() => {
				if (this.reconciliations.get(attemptId) === operation) this.reconciliations.delete(attemptId);
			})
			.catch(() => {});
		return operation;
	}
	private exact(binding: FinalizationBinding): Attempt {
		const attempt = this.attempts.get(binding.attemptId);
		if (
			!attempt ||
			attempt.binding.runId !== binding.runId ||
			attempt.binding.conversationKey !== binding.conversationKey
		)
			throw new Error("stale finalization binding");
		return attempt;
	}
}
