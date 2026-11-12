import { randomUUID } from "node:crypto";
import { expect, test } from "vitest";
import { ManagedProcessOwner } from "../src/core/managed-process-owner.ts";
import type { RuntimeLifecycle } from "../src/core/runtime-lifecycle-types.ts";
import { fence, fixture } from "./helpers/managed-process.ts";

/** An owner on the fixture's registry and book, over an attached saved lifecycle. Pure bootstrap policy, no service. */
function subject(options: { host?: boolean; bound?: boolean } = {}) {
	const { host = true, bound = true } = options;
	const f = fixture();
	const current = fence();
	const lifecycle: RuntimeLifecycle = {
		inspect: () => ({
			state: "attached",
			hostId: current.hostId,
			instanceId: current.instanceId,
			incarnation: current.incarnation,
			epoch: current.epoch,
			process: { pid: 41, birthNonce: "unit-only" },
			conversation: { piSessionId: "saved", sessionFile: "/saved/session.jsonl" },
		}),
		capture: () => current,
		isCurrent: (value) => value.instanceId === current.instanceId,
		participate: () => {},
		reconcile: async () => "applied",
		disconnect: () => {},
		cancel: () => {},
		track: () => () => {},
	};
	const owner = new ManagedProcessOwner(
		host
			? {
					processes: f.registry,
					taskFinalizations: f.taskFinalizations,
					reconcileProcesses: async () => {},
					reconcileProcessAttempt: async (_adapter, target) => ({
						...target,
						through: f.registry.inspect().reconciledThrough,
					}),
				}
			: undefined,
		lifecycle,
		async () => {},
	);
	if (bound) owner.facade.bind(f.adapter);
	return { f, owner };
}

const reservation = () => ({ attemptId: randomUUID(), marker: randomUUID() });

test("trusted adoption requires an available bound managed host and valid immutable ids", () => {
	const admission = reservation();
	expect(() => subject({ host: false, bound: false }).owner.adoptHelper(admission)).toThrow(/refused/);
	expect(() => subject({ bound: false }).owner.adoptHelper(admission)).toThrow(/refused/);
	const { owner } = subject();
	expect(() => owner.adoptHelper({ ...admission, attemptId: "not-an-attempt" })).toThrow(/refused/);
	expect(() => owner.adoptHelper({ ...admission, marker: "not-a-marker" })).toThrow(/refused/);
	// Adoption is a trusted bootstrap: it is not part of the facade that extensions and tools see.
	expect("adoptHelper" in owner.facade).toBe(false);
	owner.adoptHelper(admission);
	// One admission is pending at a time, the same one or another.
	expect(() => owner.adoptHelper(admission)).toThrow(/refused/);
	expect(() => owner.adoptHelper(reservation())).toThrow(/refused/);
	owner.retire();
	expect(() => owner.adoptHelper(admission)).toThrow(/retired/);
});

test("adoption is refused while a run is claimed", () => {
	const { owner } = subject();
	owner.claimRun("active-run");
	expect(() => owner.adoptHelper(reservation())).toThrow(/refused/);
	owner.settleRun();
	// Between runs it is accepted again.
	owner.adoptHelper(reservation());
});

test("an attempt id the registry already retains is refused when adopted", () => {
	const { f, owner } = subject();
	// An attempt of any origin that this process retains.
	const known = randomUUID();
	f.begin(known);
	expect(() => owner.adoptHelper({ attemptId: known, marker: randomUUID() })).toThrow(/refused/);
	// A refusal leaves nothing pending.
	owner.adoptHelper(reservation());
});

test("the ids of a settled helper run stay retained, so adopting them again is refused rather than failing a claim", async () => {
	const { f, owner } = subject();
	const admission = reservation();
	owner.adoptHelper(admission);
	const helper = owner.claimRun("helper-run")!;
	await helper.attempt.opening;
	owner.settleRun();
	expect(owner.attemptId).toBeUndefined();
	// Accepting these ids would make the next claim throw in begin() and leave its run half started.
	expect(() => owner.adoptHelper(admission)).toThrow(/refused/);
	const next = owner.claimRun("next-run")!;
	await next.attempt.opening;
	expect(next.attempt.intent.attemptId).not.toBe(admission.attemptId);
	expect(next.attempt.state.get("task-kind")).toBeUndefined();
	owner.settleRun();
	expect(f.opened.map((intent) => intent.attemptId)).toEqual([admission.attemptId, next.attempt.intent.attemptId]);
});

test("standalone calls do not consume the reserved helper; the next actual claimed run does", async () => {
	const { f, owner } = subject();
	const admission = reservation();
	owner.adoptHelper(admission);
	const ordinary = owner.toolContext("standalone", "bash")!;
	await ordinary.attempt.opening;
	expect(ordinary.attempt.intent.attemptId).not.toBe(admission.attemptId);
	expect(ordinary.attempt.intent.runId).toBeNull();
	expect(ordinary.attempt.state.get("task-kind")).toBeUndefined();
	f.registry.end(ordinary.attempt);
	// A standalone user command or extension spawn is no claimed run either.
	await owner.run(
		"user-bash",
		"standalone-user-call",
		() => {},
		async () => "ran",
	);
	const helper = owner.claimRun("allocated-run")!;
	await helper.attempt.opening;
	expect(helper.attempt.intent).toMatchObject({ ...admission, runId: "allocated-run" });
	expect(helper.attempt.state.get("task-kind")).toBe("helper");
	expect(helper.standalone).toBe(false);
	expect(owner.attemptId).toBe(admission.attemptId);
	expect(() => owner.adoptHelper(admission)).toThrow(/refused/);
	owner.settleRun();
	const next = owner.claimRun("another-run")!;
	await next.attempt.opening;
	expect(next.attempt.intent.attemptId).not.toBe(admission.attemptId);
	expect(next.attempt.state.get("task-kind")).toBeUndefined();
	owner.settleRun();
	owner.retire();
	// The two standalone calls, the helper run and the run after it; the helper opened under its reserved ids.
	expect(f.opened).toHaveLength(4);
	expect(f.opened[2]).toMatchObject({ ...admission, runId: "allocated-run" });
});
