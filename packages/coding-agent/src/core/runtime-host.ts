import { randomBytes, randomUUID } from "node:crypto";
import { isMainThread } from "node:worker_threads";
import { VERSION } from "../config.ts";
import { canonicalJson } from "./durable-records.ts";
import { ManagedProcessRegistry } from "./managed-process-registry.ts";
import type {
	AcknowledgedAttemptImage,
	AttemptJournalTarget,
	ManagedProcessAdapter,
	ProcessAuthentication,
} from "./managed-process-types.ts";
import { RuntimeIncarnation } from "./runtime-incarnation.ts";
import type {
	ConversationBinding,
	DesiredRuntime,
	HostProcessIdentity,
	HostRuntimeImage,
	HostRuntimeReceipt,
	RuntimeExchange,
	RuntimeVerification,
} from "./runtime-lifecycle-types.ts";

type CallContext = {
	scope: RuntimeIncarnation;
	image: HostRuntimeImage;
	entry?: DesiredRuntime;
	attempt: number;
	serial: number;
	failure?: { error: unknown };
};
type Connection = {
	id: string;
	serial: number;
	accepted: number;
	calls: Map<string, Promise<HostRuntimeReceipt>>;
	waiters: Set<CallContext>;
};
const cellKey = Symbol.for("pi.host-runtime.v1");
// The cell keeps its key and changes only its value schema: a second key would mint a second host credential.
const cellVersion = 2;
export function nextCounter(value: number): number {
	if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER)
		throw new Error("Runtime lifecycle counter exhausted; coordination is unavailable");
	return value + 1;
}
export class RuntimeHost {
	readonly #credential = randomBytes(32).toString("hex");
	readonly #hostId: string;
	readonly #process: HostProcessIdentity;
	readonly #ids: () => string;
	#incarnation: number;
	#revision: number;
	#initialEpoch: number;
	#initialVerification: number;
	#initialAttempt: number;
	#initialConnection: number;
	#image: HostRuntimeImage;
	#scopes = new Map<string, RuntimeIncarnation>();
	#failed = false;
	#connections = new WeakMap<RuntimeExchange, Connection>();
	/** Process-lifetime spawn journal; it outlives every runtime incarnation of this host. */
	readonly processes = new ManagedProcessRegistry();
	constructor(
		options: {
			process?: HostProcessIdentity;
			ids?: () => string;
			initialCounters?: {
				incarnation?: number;
				revision?: number;
				epoch?: number;
				verification?: number;
				attempt?: number;
				connection?: number;
			};
		} = {},
	) {
		this.#ids = options.ids ?? randomUUID;
		this.#hostId = this.#ids();
		this.#process = Object.freeze({ ...(options.process ?? { pid: process.pid, birthNonce: randomUUID() }) });
		this.#incarnation = options.initialCounters?.incarnation ?? 0;
		this.#revision = options.initialCounters?.revision ?? 0;
		this.#initialEpoch = options.initialCounters?.epoch ?? 0;
		this.#initialVerification = options.initialCounters?.verification ?? 0;
		this.#initialAttempt = options.initialCounters?.attempt ?? 0;
		this.#initialConnection = options.initialCounters?.connection ?? 0;
		this.#image = this.makeImage();
	}
	open(resolveConversation: () => ConversationBinding): RuntimeIncarnation {
		if (this.#failed) throw new Error("Runtime coordination is unavailable");
		try {
			this.#incarnation = nextCounter(this.#incarnation);
		} catch (error) {
			this.disable();
			throw error;
		}
		const epoch = this.#initialEpoch;
		const verification = this.#initialVerification;
		const attempt = this.#initialAttempt;
		this.#initialEpoch = 0;
		this.#initialVerification = 0;
		this.#initialAttempt = 0;
		return new RuntimeIncarnation(
			this,
			this.#hostId,
			this.#process,
			this.#ids(),
			this.#incarnation,
			resolveConversation,
			epoch,
			verification,
			attempt,
		);
	}
	getDesiredImage(): HostRuntimeImage {
		return this.#image;
	}
	reconcileProcesses(adapter: ManagedProcessAdapter): Promise<void> {
		return this.processes.reconcile(adapter, this.processAuthentication());
	}
	reconcileProcessAttempt(
		adapter: ManagedProcessAdapter,
		target: AttemptJournalTarget,
	): Promise<AcknowledgedAttemptImage> {
		return this.processes.reconcileAttempt(target, adapter, this.processAuthentication());
	}
	private processAuthentication(): ProcessAuthentication {
		return { hostId: this.#hostId, credential: this.#credential, process: this.#process };
	}
	private makeImage(): HostRuntimeImage {
		const runtimes = [...this.#scopes.values()]
			.map((scope) => scope.desired())
			.sort((a, b) => a.incarnation - b.incarnation);
		return Object.freeze({
			version: 1,
			operationId: this.#ids(),
			hostId: this.#hostId,
			process: this.#process,
			revision: this.#revision,
			maxIncarnation: this.#incarnation,
			runtimes: Object.freeze(runtimes),
		});
	}
	private disable(): void {
		this.#failed = true;
		const scopes = [...this.#scopes.values()];
		this.#scopes.clear();
		for (const scope of scopes) scope.failClosed();
	}
	private update(): void {
		try {
			this.#revision = nextCounter(this.#revision);
			this.#image = this.makeImage();
		} catch (error) {
			this.disable();
			throw error;
		}
	}
	add(scope: RuntimeIncarnation): void {
		if (this.#failed) throw new Error("Runtime coordination is unavailable");
		this.#scopes.set(scope.inspect().instanceId, scope);
		this.update();
	}
	change(scope: RuntimeIncarnation): void {
		if (this.#scopes.has(scope.inspect().instanceId)) this.update();
	}
	remove(scope: RuntimeIncarnation): void {
		if (this.#scopes.delete(scope.inspect().instanceId) && !this.#failed) this.update();
	}
	private connection(exchange: RuntimeExchange): Connection {
		let connection = this.#connections.get(exchange);
		if (!connection) {
			connection = {
				id: randomUUID(),
				serial: this.#initialConnection,
				accepted: -1,
				calls: new Map(),
				waiters: new Set(),
			};
			this.#connections.set(exchange, connection);
		}
		return connection;
	}
	private current(context: CallContext, connection: Connection, ignoreSerial = false): boolean {
		if (
			(!ignoreSerial && context.serial !== connection.serial) ||
			context.scope.latestAttemptSerial !== context.attempt
		)
			return false;
		if (!context.entry) return this.#image === context.image && connection.accepted < context.image.revision;
		return context.scope.matchesDesired(context.entry, context.image.revision, context.image.operationId);
	}
	private failConnection(connection: Connection, serial: number, failure?: { error: unknown }): void {
		if (connection.serial !== serial) return;
		if (failure) {
			for (const waiter of connection.waiters)
				if (waiter.serial === serial && this.current(waiter, connection)) waiter.failure = failure;
		}
		try {
			connection.serial = nextCounter(connection.serial);
		} catch (error) {
			this.disable();
			throw error;
		}
		connection.accepted = -1;
		let failureDuringInvalidation: unknown;
		for (const scope of [...this.#scopes.values()]) {
			try {
				scope.invalidateConnection(connection.id, serial);
			} catch (error) {
				failureDuringInvalidation ??= error;
			}
		}
		if (failureDuringInvalidation) throw failureDuringInvalidation;
	}
	disconnect(scope: RuntimeIncarnation, exchange: RuntimeExchange, serial: number): void {
		const connection = this.#connections.get(exchange);
		if (!connection || connection.serial !== serial || !scope.isObserved(exchange, serial)) return;
		if (
			!scope.hasVerification(connection.id, serial) &&
			![...connection.waiters].some((waiter) => waiter.scope === scope && waiter.serial === serial)
		)
			return;
		this.failConnection(connection, serial);
	}
	async reconcile(
		scope: RuntimeIncarnation,
		exchange: RuntimeExchange,
	): Promise<"applied" | "superseded" | "refused"> {
		if (this.#failed) throw new Error("Runtime coordination is unavailable");
		const connection = this.connection(exchange);
		const image = this.#image;
		const entry = image.runtimes.find((item) => item.instanceId === scope.inspect().instanceId);
		if (entry) scope.assertBinding();
		let attempt: number;
		try {
			attempt = nextCounter(scope.latestAttemptSerial);
		} catch (error) {
			scope.retire("quit");
			throw error;
		}
		scope.latestAttemptSerial = attempt;
		if (entry) scope.latestRequestedRevision = Math.max(scope.latestRequestedRevision, image.revision);
		const context: CallContext = { scope, image, entry, attempt, serial: connection.serial };
		scope.observe(exchange, connection.id, connection.serial);
		connection.waiters.add(context);
		const key = `${connection.serial}:${canonicalJson(image)}`;
		let raw = connection.calls.get(key);
		if (!raw) {
			raw = Promise.resolve().then(() => exchange(image, { credential: this.#credential }));
			connection.calls.set(key, raw);
			void raw.then(
				() => {
					if (connection.calls.get(key) === raw) connection.calls.delete(key);
				},
				() => {
					if (connection.calls.get(key) === raw) connection.calls.delete(key);
				},
			);
		}
		try {
			const receipt = await raw;
			if (context.failure && this.current(context, connection, true)) throw context.failure.error;
			if (!this.current(context, connection)) return "superseded";
			if (entry) scope.assertBinding();
			if (!this.current(context, connection)) return "superseded";
			const result = this.acceptReceipt(
				image,
				receipt,
				{ connectionId: connection.id, connectionRevision: context.serial },
				entry ? scope.inspect().instanceId : "",
			);
			connection.accepted = Math.max(connection.accepted, image.revision);
			return result;
		} catch (error) {
			if (context.failure) {
				if (this.current(context, connection, true)) throw context.failure.error;
				return "superseded";
			}
			if (!this.current(context, connection)) return "superseded";
			this.failConnection(connection, context.serial, { error });
			throw error;
		} finally {
			connection.waiters.delete(context);
		}
	}
	acceptReceipt(
		image: HostRuntimeImage,
		receipt: HostRuntimeReceipt,
		verification: RuntimeVerification,
		callerInstanceId: string,
	): "applied" | "refused" {
		if (this.#failed) throw new Error("Runtime coordination is unavailable");
		if (
			!receipt ||
			receipt.version !== 1 ||
			receipt.operationId !== image.operationId ||
			receipt.hostId !== image.hostId ||
			receipt.revision !== image.revision ||
			!Array.isArray(receipt.results) ||
			receipt.results.length !== image.runtimes.length ||
			typeof verification.connectionId !== "string" ||
			!verification.connectionId ||
			!Number.isSafeInteger(verification.connectionRevision) ||
			verification.connectionRevision < 0
		)
			throw new Error("Invalid runtime receipt");
		const results = new Map<string, (typeof receipt.results)[number]>();
		for (const result of receipt.results) {
			if (!result || (result.status !== "attached" && result.status !== "refused"))
				throw new Error("Invalid runtime receipt");
			const runtime: DesiredRuntime = result.status === "attached" ? result.attachment : result.runtime;
			if (!runtime || results.has(runtime.instanceId)) throw new Error("Invalid runtime receipt");
			const expected = image.runtimes.find((item) => item.instanceId === runtime.instanceId);
			if (
				!expected ||
				runtime.incarnation !== expected.incarnation ||
				runtime.epoch !== expected.epoch ||
				runtime.paneId !== expected.paneId ||
				runtime.conversation?.piSessionId !== expected.conversation.piSessionId ||
				runtime.conversation?.sessionFile !== expected.conversation.sessionFile
			)
				throw new Error("Invalid runtime receipt");
			if (
				result.status === "attached" &&
				(typeof result.attachment.mailboxId !== "string" ||
					!result.attachment.mailboxId ||
					typeof result.attachment.generationToken !== "string" ||
					!result.attachment.generationToken ||
					!Number.isSafeInteger(result.attachment.generation) ||
					result.attachment.generation <= 0)
			)
				throw new Error("Invalid runtime receipt");
			if (result.status === "refused" && !["mailbox-busy", "pane-busy", "identity-conflict"].includes(result.reason))
				throw new Error("Invalid runtime receipt");
			results.set(runtime.instanceId, result);
		}
		const refused: RuntimeIncarnation[] = [];
		for (const runtime of image.runtimes) {
			const scope = this.#scopes.get(runtime.instanceId);
			const result = results.get(runtime.instanceId);
			if (
				!scope ||
				result?.status !== "refused" ||
				!scope.matchesDesired(runtime, image.revision, image.operationId)
			)
				continue;
			scope.refuse(result.reason, image.operationId, image.revision);
			this.#scopes.delete(runtime.instanceId);
			refused.push(scope);
		}
		if (refused.length) {
			try {
				this.update();
			} finally {
				for (const scope of refused) scope.drainRefused();
			}
		}
		const caller = this.#scopes.get(callerInstanceId);
		const result = results.get(callerInstanceId);
		const entry = image.runtimes.find((runtime) => runtime.instanceId === callerInstanceId);
		if (
			caller &&
			entry &&
			result?.status === "attached" &&
			caller.matchesDesired(entry, image.revision, image.operationId)
		)
			caller.acceptAttachment(result.attachment, verification, image.revision);
		return result?.status === "refused" ? "refused" : "applied";
	}
}
export function validateProcessHostCell(value: unknown): RuntimeHost {
	if (
		typeof value !== "object" ||
		value === null ||
		!("version" in value) ||
		value.version !== cellVersion ||
		!("packageVersion" in value) ||
		value.packageVersion !== VERSION ||
		!("host" in value) ||
		typeof value.host !== "object" ||
		value.host === null ||
		![
			"open",
			"getDesiredImage",
			"acceptReceipt",
			"add",
			"change",
			"remove",
			"reconcile",
			"disconnect",
			"reconcileProcesses",
			"reconcileProcessAttempt",
		].every((key) => typeof (value.host as Record<string, unknown>)[key] === "function")
	)
		throw new Error("Incompatible runtime host cell; coordination is unavailable");
	return value.host as RuntimeHost;
}
export function getProcessRuntimeHost(): RuntimeHost {
	if (!isMainThread) throw new Error("Worker-thread coordination is unavailable");
	const cells = process as unknown as Record<symbol, unknown>;
	if (!(cellKey in cells))
		cells[cellKey] = Object.freeze({ version: cellVersion, packageVersion: VERSION, host: new RuntimeHost() });
	return validateProcessHostCell(cells[cellKey]);
}
