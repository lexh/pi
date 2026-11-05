import { canonicalJson } from "./durable-records.ts";
import type { ExternalEventDisposition, ExternalEventViewState } from "./external-event-projection.ts";

export type ExternalEventRefresh =
	| { sessionId: string; revision: number; verified: true; events: readonly ExternalEventDisposition[] }
	| { sessionId: string; revision: number; verified: false };

export class ExternalEventReconciler {
	private readonly sessionId: string;
	private readonly onChange: (revision: number) => void;
	private revision = -1;
	private verified = false;
	private dispositions = new Map<string, ExternalEventDisposition>();
	private lastUpdate: string | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;

	constructor(sessionId: string, onChange: (revision: number) => void) {
		this.sessionId = sessionId;
		this.onChange = onChange;
	}

	apply(update: ExternalEventRefresh): boolean {
		this.assertActive();
		const normalized: unknown = JSON.parse(canonicalJson(update));
		if (typeof normalized !== "object" || normalized === null || Array.isArray(normalized))
			throw new Error("Invalid external event refresh");
		const value = normalized as Record<string, unknown>;
		if (value.sessionId !== this.sessionId) throw new Error("External event session ID mismatch");
		if (
			!Number.isSafeInteger(value.revision) ||
			(value.revision as number) < 0 ||
			typeof value.verified !== "boolean"
		)
			throw new Error("Invalid external event refresh");
		const expectedKeys = value.verified
			? ["sessionId", "revision", "verified", "events"]
			: ["sessionId", "revision", "verified"];
		if (Object.keys(value).length !== expectedKeys.length || expectedKeys.some((key) => !Object.hasOwn(value, key))) {
			throw new Error("Invalid external event refresh");
		}
		const events = new Map<string, ExternalEventDisposition>();
		if (value.verified) {
			if (!Array.isArray(value.events)) throw new Error("Invalid external event dispositions");
			for (const item of value.events) {
				if (typeof item !== "object" || item === null || Array.isArray(item))
					throw new Error("Invalid external event disposition");
				const event = item as Record<string, unknown>;
				if (
					typeof event.recipientIdentity !== "string" ||
					!event.recipientIdentity ||
					typeof event.eventId !== "string" ||
					!event.eventId ||
					typeof event.state !== "string" ||
					!["pending", "read", "expired", "dropped"].includes(event.state) ||
					!(
						event.expiresAt === null ||
						(typeof event.expiresAt === "number" && Number.isFinite(event.expiresAt) && event.expiresAt >= 0)
					) ||
					!(event.reason === null || typeof event.reason === "string")
				)
					throw new Error("Invalid external event disposition");
				const key = JSON.stringify([event.recipientIdentity, event.eventId]);
				if (events.has(key)) throw new Error("Duplicate external event disposition");
				events.set(
					key,
					Object.freeze({
						recipientIdentity: event.recipientIdentity,
						eventId: event.eventId,
						state: event.state as ExternalEventDisposition["state"],
						expiresAt: event.expiresAt as number | null,
						reason: event.reason as string | null,
					}),
				);
			}
		}
		const revision = value.revision as number;
		if (revision < this.revision) return false;
		const signature = canonicalJson(normalized);
		if (revision === this.revision) {
			if (signature !== this.lastUpdate) throw new Error("Conflicting external event refresh revision");
			return false;
		}
		this.revision = revision;
		this.verified = value.verified as boolean;
		if (this.verified) this.dispositions = events;
		this.lastUpdate = signature;
		this.armTimer();
		this.onChange(this.revision);
		return true;
	}

	getState(): ExternalEventViewState {
		this.assertActive();
		return { revision: this.revision, verified: this.verified, dispositions: new Map(this.dispositions) };
	}

	invalidate(): void {
		this.assertActive();
		this.onChange(this.revision);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
	}

	private assertActive(): void {
		if (this.disposed) throw new Error("External event reconciler disposed");
	}

	private armTimer(): void {
		if (this.disposed) return;
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		const now = Date.now();
		let earliest = Infinity;
		for (const event of this.dispositions.values()) {
			if (event.state === "pending" && event.expiresAt !== null && event.expiresAt > now)
				earliest = Math.min(earliest, event.expiresAt);
		}
		if (!Number.isFinite(earliest)) return;
		this.timer = setTimeout(
			() => {
				this.timer = undefined;
				if (Date.now() >= earliest) this.onChange(this.revision);
				this.armTimer();
			},
			Math.min(earliest - now, 2_147_483_647),
		);
		this.timer.unref?.();
	}
}
