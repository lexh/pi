import type { ManagedProcesses } from "./managed-process-types.ts";

export const MANAGED_PROCESS_CAPABILITIES = Object.freeze({
	protocol: "managed-processes/1",
	name: "managed-processes",
	version: 1,
	gate: "fd",
	identity: "kinfo-us-v1",
	retention: "service-cleanup",
	boundary: "attributed",
});

export interface ManagedProcessSupport {
	readonly managedProcessCapabilities: typeof MANAGED_PROCESS_CAPABILITIES;
	readonly managedProcesses: ManagedProcesses;
}

const unsupported =
	"Managed process integration disabled: install a compatible pi build with managed-processes/1. Ordinary pi remains available.";

function descriptor(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const d = (value as Record<string, unknown>).managedProcessCapabilities;
	return (
		typeof d === "object" &&
		d !== null &&
		Object.entries(MANAGED_PROCESS_CAPABILITIES).every(
			([key, expected]) => (d as Record<string, unknown>)[key] === expected,
		)
	);
}

/** Throws unless a session exposes the frozen managed-processes/1 descriptor and the complete facade. */
export function assertManagedProcessSupport(value: unknown): asserts value is ManagedProcessSupport {
	if (!descriptor(value)) throw new Error(unsupported);
	const facade = value.managedProcesses;
	if (
		typeof facade !== "object" ||
		facade === null ||
		![
			"bind",
			"reconcile",
			"captureAttemptVersion",
			"reconcileAttempt",
			"inspect",
			"requestStop",
			"managedSpawn",
			"acknowledgeStop",
			"declareTaskFinalization",
			"reconcileFinalizations",
		].every((key) => typeof (facade as Record<string, unknown>)[key] === "function")
	)
		throw new Error(unsupported);
}

/**
 * Throws unless an extension API exposes the descriptor, the lazy own getter and the two extension actions,
 * without invoking the getter (it is not usable while extensions load).
 */
export function assertExtensionManagedProcessSupport(value: unknown): asserts value is ManagedProcessSupport {
	if (
		!descriptor(value) ||
		typeof Object.getOwnPropertyDescriptor(value, "managedProcesses")?.get !== "function" ||
		typeof value.managedSpawn !== "function" ||
		typeof value.declareProcessCoverage !== "function"
	)
		throw new Error(unsupported);
}
