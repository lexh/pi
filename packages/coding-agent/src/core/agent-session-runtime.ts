import { constants, copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join, parse } from "node:path";
import { pathsEqual, resolvePath } from "../utils/paths.ts";
import type { AgentSession } from "./agent-session.ts";
import { RuntimeDisposedError, RuntimeReplacementInProgressError } from "./agent-session-coordination.ts";
import type { AgentSessionRuntimeDiagnostic, AgentSessionServices } from "./agent-session-services.ts";
import type {
	ProjectTrustContext,
	ReplacedSessionContext,
	SessionShutdownEvent,
	SessionStartEvent,
} from "./extensions/index.ts";
import type { CreateAgentSessionResult } from "./sdk.ts";
import { assertSessionCwdExists } from "./session-cwd.ts";
import { SessionManager } from "./session-manager.ts";

/**
 * Result returned by runtime creation.
 *
 * The caller gets the created session, its cwd-bound services, and all
 * diagnostics collected during setup.
 */
export interface CreateAgentSessionRuntimeResult extends CreateAgentSessionResult {
	services: AgentSessionServices;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

/**
 * Creates a full runtime for a target cwd and session manager.
 *
 * The factory closes over process-global fixed inputs, recreates cwd-bound
 * services for the effective cwd, resolves session options against those
 * services, and finally creates the AgentSession.
 */
export type CreateAgentSessionRuntimeFactory = (options: {
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	projectTrustContext?: ProjectTrustContext;
}) => Promise<CreateAgentSessionRuntimeResult>;

/**
 * Thrown when /import references a JSONL file path that does not exist.
 */
export class SessionImportFileNotFoundError extends Error {
	readonly filePath: string;

	constructor(filePath: string) {
		super(`File not found: ${filePath}`);
		this.name = "SessionImportFileNotFoundError";
		this.filePath = filePath;
	}
}

function extractUserMessageText(content: string | Array<{ type: string; text?: string }>): string {
	if (typeof content === "string") {
		return content;
	}

	return content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

/**
 * Owns the current AgentSession plus its cwd-bound services.
 *
 * Session replacement methods tear down the current runtime first, then create
 * and apply the next runtime. If creation fails, the error is propagated to the
 * caller. The caller is responsible for user-facing error handling.
 */
export class AgentSessionRuntime {
	private rebindSession?: (session: AgentSession) => Promise<void>;
	private beforeSessionInvalidate?: () => void;
	private _session: AgentSession;
	private _services: AgentSessionServices;
	private readonly createRuntime: CreateAgentSessionRuntimeFactory;
	private _diagnostics: AgentSessionRuntimeDiagnostic[];
	private _modelFallbackMessage?: string;
	private replacementInProgress = false;
	private disposed = false;
	private cleanup?: Promise<void>;
	private teardown?: { session: AgentSession; promise: Promise<void> };
	private candidate?: AgentSession;
	private afterReplacement?: () => Promise<void>;
	/**
	 * When set, newSession, fork, switchSession and importFromJsonl refused because another
	 * replacement is in progress call this and resolve { cancelled: true } instead of rejecting with
	 * RuntimeReplacementInProgressError. Interactive mode sets it to report the refusal as a status.
	 * reload() always rejects: it has no cancelled result.
	 */
	onReplacementRefused?: () => void;

	constructor(
		_session: AgentSession,
		_services: AgentSessionServices,
		createRuntime: CreateAgentSessionRuntimeFactory,
		_diagnostics: AgentSessionRuntimeDiagnostic[] = [],
		_modelFallbackMessage?: string,
	) {
		this._session = _session;
		this._services = _services;
		this.createRuntime = createRuntime;
		this._diagnostics = _diagnostics;
		this._modelFallbackMessage = _modelFallbackMessage;
	}

	get services(): AgentSessionServices {
		return this._services;
	}

	get session(): AgentSession {
		return this._session;
	}

	get cwd(): string {
		return this._services.cwd;
	}

	get diagnostics(): readonly AgentSessionRuntimeDiagnostic[] {
		return this._diagnostics;
	}

	get modelFallbackMessage(): string | undefined {
		return this._modelFallbackMessage;
	}

	setRebindSession(rebindSession?: (session: AgentSession) => Promise<void>): void {
		this.rebindSession = rebindSession;
	}

	/**
	 * Set a synchronous callback that runs after `session_shutdown` handlers finish
	 * but before the current session is invalidated.
	 *
	 * This is for host-owned UI teardown that must not yield to the event loop,
	 * such as detaching extension-provided TUI components before the old extension
	 * context becomes stale.
	 */
	setBeforeSessionInvalidate(beforeSessionInvalidate?: () => void): void {
		this.beforeSessionInvalidate = beforeSessionInvalidate;
	}

	private async emitBeforeSwitch(
		reason: "new" | "resume",
		targetSessionFile?: string,
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_switch")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_switch",
			reason,
			targetSessionFile,
		});
		this.assertActive(this.session);
		return { cancelled: result?.cancel === true };
	}

	private async emitBeforeFork(
		entryId: string,
		options: { position: "before" | "at" },
	): Promise<{ cancelled: boolean }> {
		const runner = this.session.extensionRunner;
		if (!runner.hasHandlers("session_before_fork")) {
			return { cancelled: false };
		}

		const result = await runner.emit({
			type: "session_before_fork",
			entryId,
			...options,
		});
		this.assertActive(this.session);
		return { cancelled: result?.cancel === true };
	}

	get isReplacementInProgress(): boolean {
		return this.replacementInProgress;
	}

	private assertActive(session?: AgentSession): void {
		if (this.disposed || session?.isDisposed) throw new RuntimeDisposedError();
	}

	/**
	 * Run a replacement under this runtime's fence and the outgoing session's. Refused while either is
	 * held. The withSession callback recorded by finishSessionReplacement runs after both release.
	 */
	private async replace<T extends { cancelled: boolean }>(operation: () => Promise<T>): Promise<T> {
		this.assertActive();
		if (this.replacementInProgress) return this.refuseReplacement<T>();
		this.assertActive(this._session);
		if (this._session.isReplacementInProgress) return this.refuseReplacement<T>();
		this.replacementInProgress = true;
		const outgoing = this._session;
		let result: T;
		let afterReplacement: (() => Promise<void>) | undefined;
		try {
			result = await outgoing.withRuntimeReplacement(operation);
			afterReplacement = this.afterReplacement;
		} finally {
			this.afterReplacement = undefined;
			this.replacementInProgress = false;
		}
		await afterReplacement?.();
		return result;
	}

	private refuseReplacement<T extends { cancelled: boolean }>(): T {
		if (!this.onReplacementRefused) throw new RuntimeReplacementInProgressError();
		this.onReplacementRefused();
		return { cancelled: true } as T;
	}

	/** Retire, settle, shut down, invalidate and dispose a session once; disposal and a replacement share it. */
	private teardownSession(
		outgoing: AgentSession,
		reason: SessionShutdownEvent["reason"],
		targetSessionFile?: string,
	): Promise<void> {
		if (this.teardown?.session === outgoing) return this.teardown.promise;
		const completion = Promise.withResolvers<void>();
		this.teardown = { session: outgoing, promise: completion.promise };
		void (async () => {
			try {
				outgoing.retireRuntime(reason);
				await outgoing.abort();
				await outgoing.shutdownRuntime(reason, targetSessionFile);
			} finally {
				try {
					this.beforeSessionInvalidate?.();
				} finally {
					outgoing.dispose();
				}
			}
		})().then(completion.resolve, completion.reject);
		return completion.promise;
	}

	/**
	 * Apply a created runtime under the candidate's replacement fence. newSession's setup runs before the
	 * candidate becomes current, rebind after. A candidate that fails or loses to dispose() is disposed.
	 */
	private async applyCandidate(
		result: CreateAgentSessionRuntimeResult,
		setup?: (sessionManager: SessionManager) => Promise<void>,
	): Promise<void> {
		const next = result.session;
		this.candidate = next;
		try {
			this.assertActive();
			await next.withRuntimeReplacement(async () => {
				this.assertActive(next);
				if (setup) {
					await setup(next.sessionManager);
					this.assertActive(next);
					next.refreshContext();
				}
				this.apply(result);
				if (this.rebindSession) {
					await this.rebindSession(next);
					this.assertActive(next);
				}
			});
		} catch (error) {
			next.dispose();
			throw error;
		} finally {
			if (this.candidate === next) this.candidate = undefined;
		}
	}

	private async teardownCurrent(reason: SessionShutdownEvent["reason"], targetSessionFile?: string): Promise<void> {
		// Settle any active response first so the aborted turn (including tool
		// results) is persisted to the outgoing session before it is replaced.
		await this.teardownSession(this.session, reason, targetSessionFile);
		this.assertActive();
	}

	private apply(result: CreateAgentSessionRuntimeResult): void {
		this._session = result.session;
		this._services = result.services;
		this._diagnostics = result.diagnostics;
		this._modelFallbackMessage = result.modelFallbackMessage;
	}

	private async finishSessionReplacement(withSession?: (ctx: ReplacedSessionContext) => Promise<void>): Promise<void> {
		// applyCandidate rebound the session under its fence; withSession runs once replace() releases the fences.
		const session = this.session;
		this.afterReplacement = async () => {
			this.assertActive(session);
			if (withSession) await withSession(session.createReplacedSessionContext());
		};
	}

	async switchSession(
		sessionPath: string,
		options?: {
			cwdOverride?: string;
			withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
			projectTrustContextFactory?: (cwd: string) => ProjectTrustContext;
		},
	): Promise<{ cancelled: boolean }> {
		return this.replace(() => this.switchSessionUnfenced(sessionPath, options));
	}

	private async switchSessionUnfenced(
		sessionPath: string,
		options?: Parameters<AgentSessionRuntime["switchSession"]>[1],
	): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("resume", sessionPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		if (!existsSync(resolvePath(sessionPath))) throw new Error(`Session file not found: ${sessionPath}`);
		const sessionManager = SessionManager.open(sessionPath, undefined, options?.cwdOverride);
		assertSessionCwdExists(sessionManager, this.cwd);
		await this.teardownCurrent("resume", sessionManager.getSessionFile());
		await this.applyCandidate(
			await this.createRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
				projectTrustContext: options?.projectTrustContextFactory?.(sessionManager.getCwd()),
			}),
		);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	async newSession(options?: {
		parentSession?: string;
		setup?: (sessionManager: SessionManager) => Promise<void>;
		withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
	}): Promise<{ cancelled: boolean }> {
		return this.replace(() => this.newSessionUnfenced(options));
	}

	private async newSessionUnfenced(
		options?: Parameters<AgentSessionRuntime["newSession"]>[0],
	): Promise<{ cancelled: boolean }> {
		const beforeResult = await this.emitBeforeSwitch("new");
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		const sessionDir = this.session.sessionManager.getSessionDir();
		const sessionManager = this.session.sessionManager.isPersisted()
			? SessionManager.create(this.cwd, sessionDir)
			: SessionManager.inMemory(this.cwd);
		if (options?.parentSession) {
			sessionManager.newSession({ parentSession: options.parentSession });
		}

		await this.teardownCurrent("new", sessionManager.getSessionFile());
		await this.applyCandidate(
			await this.createRuntime({
				cwd: this.cwd,
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "new", previousSessionFile },
			}),
			options?.setup,
		);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false };
	}

	async fork(
		entryId: string,
		options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		return this.replace(() => this.forkUnfenced(entryId, options));
	}

	private async forkUnfenced(
		entryId: string,
		options?: Parameters<AgentSessionRuntime["fork"]>[1],
	): Promise<{ cancelled: boolean; selectedText?: string }> {
		const position = options?.position ?? "before";
		const beforeResult = await this.emitBeforeFork(entryId, { position });
		if (beforeResult.cancelled) {
			return { cancelled: true };
		}
		let targetLeafId: string | null;
		let selectedText: string | undefined;

		const selectedEntry = this.session.sessionManager.getEntry(entryId);
		if (!selectedEntry) {
			throw new Error("Invalid entry ID for forking");
		}

		if (position === "at") {
			targetLeafId = selectedEntry.id;
		} else {
			if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
				throw new Error("Invalid entry ID for forking");
			}
			targetLeafId = selectedEntry.parentId;
			selectedText = extractUserMessageText(selectedEntry.message.content);
		}

		const previousSessionFile = this.session.sessionFile;
		if (this.session.sessionManager.isPersisted()) {
			const currentSessionFile = this.session.sessionFile;
			if (!currentSessionFile) {
				throw new Error("Persisted session is missing a session file");
			}
			const sessionDir = this.session.sessionManager.getSessionDir();
			if (!targetLeafId) {
				const sessionManager = SessionManager.create(this.cwd, sessionDir);
				sessionManager.newSession({ parentSession: currentSessionFile });
				await this.teardownCurrent("fork", sessionManager.getSessionFile());
				await this.applyCandidate(
					await this.createRuntime({
						cwd: this.cwd,
						agentDir: this.services.agentDir,
						sessionManager,
						sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
					}),
				);
				await this.finishSessionReplacement(options?.withSession);
				return { cancelled: false, selectedText };
			}

			if (!existsSync(currentSessionFile)) {
				throw new Error("This session has not been saved yet. Send a message before cloning or forking it.");
			}
			const sessionManager = SessionManager.open(currentSessionFile, sessionDir);
			const forkedSessionPath = sessionManager.createBranchedSession(targetLeafId);
			if (!forkedSessionPath) {
				throw new Error("Failed to create forked session");
			}
			await this.teardownCurrent("fork", sessionManager.getSessionFile());
			await this.applyCandidate(
				await this.createRuntime({
					cwd: sessionManager.getCwd(),
					agentDir: this.services.agentDir,
					sessionManager,
					sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
				}),
			);
			await this.finishSessionReplacement(options?.withSession);
			return { cancelled: false, selectedText };
		}

		const sessionManager = this.session.sessionManager;
		await this.teardownCurrent("fork", sessionManager.getSessionFile());
		if (!targetLeafId) {
			sessionManager.newSession({ parentSession: previousSessionFile });
		} else {
			sessionManager.createBranchedSession(targetLeafId);
		}
		await this.applyCandidate(
			await this.createRuntime({
				cwd: this.cwd,
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "fork", previousSessionFile },
			}),
		);
		await this.finishSessionReplacement(options?.withSession);
		return { cancelled: false, selectedText };
	}

	/**
	 * Import a session JSONL file and switch runtime state to the imported session.
	 *
	 * @returns `{ cancelled: true }` when cancelled by `session_before_switch`, otherwise `{ cancelled: false }`.
	 * @throws {SessionImportFileNotFoundError} When the input path does not exist.
	 * @throws {MissingSessionCwdError} When the imported session cwd cannot be resolved and no override is provided.
	 */
	async importFromJsonl(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		return this.replace(() => this.importFromJsonlUnfenced(inputPath, cwdOverride));
	}

	private async importFromJsonlUnfenced(inputPath: string, cwdOverride?: string): Promise<{ cancelled: boolean }> {
		const resolvedPath = resolvePath(inputPath);
		if (!existsSync(resolvedPath)) {
			throw new SessionImportFileNotFoundError(resolvedPath);
		}

		const sessionDir = this.session.sessionManager.getSessionDir();
		if (!existsSync(sessionDir)) {
			mkdirSync(sessionDir, { recursive: true });
		}

		let destinationPath = join(sessionDir, basename(resolvedPath));
		const sourceAlreadyStored = pathsEqual(destinationPath, resolvedPath);
		if (!sourceAlreadyStored) {
			const { name, ext } = parse(destinationPath);
			let suffix = 1;
			while (existsSync(destinationPath)) {
				destinationPath = join(sessionDir, `${name}-${suffix++}${ext}`);
			}
		}
		const beforeResult = await this.emitBeforeSwitch("resume", destinationPath);
		if (beforeResult.cancelled) {
			return beforeResult;
		}

		const previousSessionFile = this.session.sessionFile;
		if (!sourceAlreadyStored) {
			copyFileSync(resolvedPath, destinationPath, constants.COPYFILE_EXCL);
		}

		const sessionManager = SessionManager.open(destinationPath, sessionDir, cwdOverride);
		try {
			assertSessionCwdExists(sessionManager, this.cwd);
		} catch (error) {
			// The import did not happen; drop the copy so a retry with a cwd override or a fork leaves no stray file.
			if (!sourceAlreadyStored) rmSync(destinationPath, { force: true });
			throw error;
		}
		await this.teardownCurrent("resume", sessionManager.getSessionFile());
		await this.applyCandidate(
			await this.createRuntime({
				cwd: sessionManager.getCwd(),
				agentDir: this.services.agentDir,
				sessionManager,
				sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile },
			}),
		);
		await this.finishSessionReplacement();
		return { cancelled: false };
	}

	async reload(options?: {
		beforeReload?: () => void | Promise<void>;
		beforeSessionStart?: () => void | Promise<void>;
	}): Promise<void> {
		this.assertActive();
		if (this.replacementInProgress) throw new RuntimeReplacementInProgressError();
		this.assertActive(this.session);
		this.replacementInProgress = true;
		const session = this.session;
		try {
			await session.reload({ ...options, assertActive: () => this.assertActive(session) });
			this.assertActive(session);
		} finally {
			this.replacementInProgress = false;
		}
	}

	/**
	 * Dispose the session for process exit. Also waits for credential writes in progress: an OAuth
	 * refresh may already have spent the old single-use refresh token, so exiting before the new one
	 * is saved would lose the login (#11692).
	 */
	dispose(): Promise<void> {
		if (this.cleanup) return this.cleanup;
		this.disposed = true;
		const session = this.session;
		session.markRuntimeUnavailable();
		if (this.candidate && this.candidate !== session) this.candidate.dispose();
		this.cleanup = this.teardownSession(session, "quit").then(() =>
			this.services.modelRuntime.settleCredentialWrites(),
		);
		return this.cleanup;
	}
}

/**
 * Create the initial runtime from a runtime factory and initial session target.
 *
 * The same factory is stored on the returned AgentSessionRuntime and reused for
 * later /new, /resume, /fork, and import flows.
 */
export async function createAgentSessionRuntime(
	createRuntime: CreateAgentSessionRuntimeFactory,
	options: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: SessionStartEvent;
	},
): Promise<AgentSessionRuntime> {
	assertSessionCwdExists(options.sessionManager, options.cwd);
	const result = await createRuntime(options);
	return new AgentSessionRuntime(
		result.session,
		result.services,
		createRuntime,
		result.diagnostics,
		result.modelFallbackMessage,
	);
}

export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
