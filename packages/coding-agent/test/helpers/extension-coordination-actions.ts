import type { ExtensionCoordinationActions } from "../../src/core/extensions/runner.ts";
import { createUnavailableRuntimeLifecycle } from "../../src/core/runtime-incarnation.ts";

/** Inert coordination actions for tests that bind a runner by hand: nothing is bound or coordinated. */
export const coordinationExtensionActions: ExtensionCoordinationActions = {
	refreshExternalEvents: () => true,
	getRuntimeLifecycle: () => createUnavailableRuntimeLifecycle("test"),
	getRequestAdmission: () => ({ bind: () => () => {}, stageCompletedWait: () => {}, reconcile: async () => {} }),
	getCoordinationScheduler: () => ({
		bind: () => () => {},
		wait: async () => ({ waitId: "w", status: "interrupted" as const, reason: "cancelled" as const }),
		grant: async (
			target: Parameters<ReturnType<ExtensionCoordinationActions["getCoordinationScheduler"]>["grant"]>[0],
		) => ({ grantId: "g", target, state: "revoked" as const }),
		refresh: async () => {},
		reconcile: async () => {},
		cancel: () => {},
		inspect: () => ({
			bound: false,
			permissionEpoch: 0,
			activeWaits: 0,
			pendingClaim: false,
			gates: [],
			grants: [],
		}),
	}),
};
