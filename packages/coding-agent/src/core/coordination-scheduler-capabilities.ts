import type { CoordinationScheduler } from "./coordination-scheduler-types.ts";

/** Capability descriptor for wake and continuation arbitration (`coordination-scheduler/1`). */
export const COORDINATION_SCHEDULER_CAPABILITIES = Object.freeze({
	protocol: "coordination-scheduler/1",
	correlatedWaitReferences: true,
	instanceEpochPermissions: true,
	atomicAdmissionConsumption: true,
	naturalUserWakeArbitration: true,
	finalTextSettlement: true,
	idleClaims: true,
	synchronousGates: true,
	preFocusEscape: true,
	noAutomaticReplay: true,
});

export interface CoordinationSchedulerSupport {
	readonly coordinationSchedulerCapabilities: typeof COORDINATION_SCHEDULER_CAPABILITIES;
	readonly coordinationScheduler: CoordinationScheduler;
}
export interface ExtensionCoordinationSchedulerSupport extends CoordinationSchedulerSupport {}

const unsupported =
	"Coordination scheduler integration disabled: install a pi build with coordination-scheduler/1. Ordinary pi remains available.";

function hasDescriptor(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const descriptor = (value as Record<string, unknown>).coordinationSchedulerCapabilities;
	if (typeof descriptor !== "object" || descriptor === null) return false;
	return Object.entries(COORDINATION_SCHEDULER_CAPABILITIES).every(
		([key, expected]) => (descriptor as Record<string, unknown>)[key] === expected,
	);
}

/** Verify that an SDK session exposes the `coordination-scheduler/1` capability and callable facade. */
export function assertCoordinationSchedulerSupport(value: unknown): asserts value is CoordinationSchedulerSupport {
	if (!hasDescriptor(value)) throw new Error(unsupported);
	const facade = value.coordinationScheduler;
	if (
		typeof facade !== "object" ||
		facade === null ||
		!["bind", "wait", "grant", "refresh", "reconcile", "cancel", "inspect"].every(
			(key) => typeof (facade as Record<string, unknown>)[key] === "function",
		)
	)
		throw new Error(unsupported);
}

/** Verify that an extension API exposes `coordination-scheduler/1` and its own dynamic `coordinationScheduler` getter without invoking it. */
export function assertExtensionCoordinationSchedulerSupport(
	value: unknown,
): asserts value is ExtensionCoordinationSchedulerSupport {
	if (
		!hasDescriptor(value) ||
		typeof Object.getOwnPropertyDescriptor(value, "coordinationScheduler")?.get !== "function"
	)
		throw new Error(unsupported);
}
