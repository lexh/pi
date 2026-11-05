import { createHarness, type HarnessOptions } from "../suite/harness.ts";
import { savedFixture } from "./external-events.ts";
import { FakeRequestCoordinator } from "./fake-request-coordinator.ts";
import { FakeRuntimeCoordinator } from "./fake-runtime-coordinator.ts";

export async function createAdmissionHarness(
	options: Omit<HarnessOptions, "sessionManager"> & {
		clock?: () => number;
		coordinator?: (
			runtime: FakeRuntimeCoordinator,
			clock: (() => number) | undefined,
			mailboxId: string,
		) => FakeRequestCoordinator;
	} = {},
) {
	const fixture = savedFixture();
	const { clock, coordinator: coordinatorFactory, ...harnessOptions } = options;
	const harness = await createHarness({ ...harnessOptions, sessionManager: fixture.manager });
	const runtimeCoordinator = new FakeRuntimeCoordinator();
	const lifecycle = harness.session.runtimeLifecycle;
	lifecycle.participate();
	await lifecycle.reconcile(runtimeCoordinator.exchange);
	const fence = lifecycle.capture();
	const coordinator =
		coordinatorFactory?.(runtimeCoordinator, clock, fence.mailboxId) ??
		new FakeRequestCoordinator(runtimeCoordinator, clock, undefined, fence.mailboxId);
	return {
		harness,
		manager: fixture.manager,
		coordinator,
		runtimeCoordinator,
		fence,
		cleanup: () => {
			harness.cleanup();
			fixture.cleanup();
		},
	};
}
