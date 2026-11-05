import type { RequestAdmission } from "./request-admission-types.ts";

export const REQUEST_ADMISSION_CAPABILITIES = Object.freeze({
	protocol: "ordered-request-admission/1",
	finiteSnapshot: true,
	finalContextInclusion: true,
	canonicalReceiptBarrier: true,
	unreadSafeCompaction: true,
	atomicAdmissionConsumptionJoin: true,
	durableAnchoredMaterialization: true,
	cancellationFencing: true,
	recoveryWithoutReplay: true,
});

export interface RequestAdmissionSupport {
	readonly requestAdmissionCapabilities: typeof REQUEST_ADMISSION_CAPABILITIES;
	readonly requestAdmission: RequestAdmission;
}
export interface ExtensionRequestAdmissionSupport extends RequestAdmissionSupport {}

const unsupported =
	"Request admission integration disabled: install a pi build with ordered-request-admission/1. Ordinary pi remains available.";

function hasDescriptor(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) return false;
	const descriptor = (value as Record<string, unknown>).requestAdmissionCapabilities;
	if (typeof descriptor !== "object" || descriptor === null) return false;
	return Object.entries(REQUEST_ADMISSION_CAPABILITIES).every(
		([key, expected]) => (descriptor as Record<string, unknown>)[key] === expected,
	);
}

export function assertRequestAdmissionSupport(value: unknown): asserts value is RequestAdmissionSupport {
	if (!hasDescriptor(value)) throw new Error(unsupported);
	const facade = value.requestAdmission;
	if (
		typeof facade !== "object" ||
		facade === null ||
		!["bind", "stageCompletedWait", "reconcile"].every(
			(key) => typeof (facade as Record<string, unknown>)[key] === "function",
		)
	)
		throw new Error(unsupported);
}

export function assertExtensionRequestAdmissionSupport(
	value: unknown,
): asserts value is ExtensionRequestAdmissionSupport {
	if (!hasDescriptor(value) || typeof Object.getOwnPropertyDescriptor(value, "requestAdmission")?.get !== "function")
		throw new Error(unsupported);
}
