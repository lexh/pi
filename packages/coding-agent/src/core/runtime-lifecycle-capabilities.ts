import type { RuntimeLifecycle } from "./runtime-lifecycle-types.ts";

export const RUNTIME_LIFECYCLE_CAPABILITIES = Object.freeze({
	protocol: "host-runtime-lifecycle/1",
	processOwnedCredential: true,
	monotonicIncarnations: true,
	synchronousEpochRevocation: true,
	authenticatedHostImages: true,
	samePidReplacement: true,
});

export interface RuntimeLifecycleSupport {
	readonly runtimeLifecycleCapabilities: typeof RUNTIME_LIFECYCLE_CAPABILITIES;
	readonly runtimeLifecycle: RuntimeLifecycle;
}
export interface ExtensionRuntimeLifecycleSupport {
	readonly runtimeLifecycleCapabilities: typeof RUNTIME_LIFECYCLE_CAPABILITIES;
	getRuntimeLifecycle(): RuntimeLifecycle;
}

function hasDescriptor(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const descriptor = (value as Record<string, unknown>).runtimeLifecycleCapabilities;
	if (typeof descriptor !== "object" || descriptor === null) return false;
	return Object.entries(RUNTIME_LIFECYCLE_CAPABILITIES).every(
		([key, expected]) => (descriptor as Record<string, unknown>)[key] === expected,
	);
}
const unsupported =
	"Runtime lifecycle integration disabled: install a pi build with host-runtime-lifecycle/1. Ordinary pi remains available.";
export function assertRuntimeLifecycleSupport(value: unknown): asserts value is RuntimeLifecycleSupport {
	if (!hasDescriptor(value)) throw new Error(unsupported);
	const facade = value.runtimeLifecycle;
	if (
		typeof facade !== "object" ||
		facade === null ||
		!["participate", "cancel", "disconnect", "inspect", "capture", "isCurrent", "track", "reconcile"].every(
			(key) => typeof (facade as Record<string, unknown>)[key] === "function",
		)
	)
		throw new Error(unsupported);
}
export function assertExtensionRuntimeLifecycleSupport(
	value: unknown,
): asserts value is ExtensionRuntimeLifecycleSupport {
	if (!hasDescriptor(value) || typeof value.getRuntimeLifecycle !== "function") throw new Error(unsupported);
}
