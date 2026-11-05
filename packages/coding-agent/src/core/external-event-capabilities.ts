import type { ExternalEventDisplayItem } from "./external-event-projection.ts";
import type { ExternalEventRefresh } from "./external-event-reconciliation.ts";
import type { SessionEntry } from "./session-manager.ts";

export const EXTERNAL_EVENT_CAPABILITIES = Object.freeze({
	contract: "logical-external-events/1",
	encoding: "pi-custom-v1",
	canonicalNonContext: true,
	nonEditableAdmissions: true,
	conversationWidePendingDisplay: true,
	coalescedDisplay: true,
	publicRefresh: true,
	isolatedForkHistory: true,
});

export interface ExtensionExternalEventSupport {
	readonly externalEventCapabilities: typeof EXTERNAL_EVENT_CAPABILITIES;
	refreshExternalEvents(update?: ExternalEventRefresh): boolean;
}
export interface ExternalEventProjectionSupport extends ExtensionExternalEventSupport {
	getExternalEventView(visibleEntries?: readonly SessionEntry[]): ExternalEventDisplayItem[];
}

function hasDescriptor(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const object = value as Record<string, unknown>;
	const descriptor = object.externalEventCapabilities;
	if (typeof descriptor !== "object" || descriptor === null) return false;
	return Object.entries(EXTERNAL_EVENT_CAPABILITIES).every(
		([key, expected]) => (descriptor as Record<string, unknown>)[key] === expected,
	);
}

const unsupported =
	"External event integration disabled: install a pi build with durable-records/1 and logical-external-events/1. Ordinary pi remains available.";

export function assertExternalEventProjectionSupport(value: unknown): asserts value is ExternalEventProjectionSupport {
	if (
		!hasDescriptor(value) ||
		typeof value.refreshExternalEvents !== "function" ||
		typeof value.getExternalEventView !== "function"
	)
		throw new Error(unsupported);
}

export function assertExtensionExternalEventSupport(value: unknown): asserts value is ExtensionExternalEventSupport {
	if (!hasDescriptor(value) || typeof value.refreshExternalEvents !== "function") throw new Error(unsupported);
}
