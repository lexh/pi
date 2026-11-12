import { expect, test } from "vitest";
import { type FinalizationBinding, TaskFinalizationBook } from "../src/core/task-finalization.ts";
import { deferred, fixture } from "./helpers/managed-process.ts";

const key = JSON.stringify(["conversation", "/saved/conversation.jsonl"]);
const otherKey = JSON.stringify(["other", null]);
const inline = (attemptId: string, runId: string): FinalizationBinding => ({
	attemptId,
	runId,
	conversationKey: key,
	kind: "inline",
});
const helper = (attemptId: string, runId: string): FinalizationBinding => ({
	attemptId,
	runId,
	conversationKey: key,
	kind: "helper",
});

test("a stop latches only the exact active inline run, never a later run of the conversation", () => {
	const book = new TaskFinalizationBook();
	const first = inline("attempt-one", "run-one");
	book.bind(first);
	expect(book.current(key)).toBe(first);
	expect(book.blocks(key, first)).toBe(false);
	book.stop("attempt-one");
	expect(book.blocks(key, first)).toBe(true);
	const second = inline("attempt-two", "run-two");
	book.bind(second);
	expect(book.current(key)).toBe(second);
	expect(book.blocks(key, second)).toBe(false);
	// Without an active run nothing is vetoed, and another conversation is never affected.
	expect(book.blocks(key)).toBe(false);
	expect(book.blocks(otherKey, first)).toBe(false);
});

test("a stopped helper blocks its conversation permanently, whatever is selected or active", () => {
	const book = new TaskFinalizationBook();
	const task = helper("helper-attempt", "helper-run");
	book.bind(task);
	expect(book.blocks(key, task)).toBe(false);
	book.stop("helper-attempt");
	expect(book.blocks(key)).toBe(true);
	const later = inline("inline-attempt", "inline-run");
	book.bind(later);
	expect(book.blocks(key, later)).toBe(true);
	expect(book.blocks(otherKey)).toBe(false);
});

test("a stopped attempt cannot reopen, an attempt keeps its conversation and kind, and stopping an unknown attempt is a no-op", () => {
	const book = new TaskFinalizationBook();
	const task = inline("attempt-one", "run-one");
	book.bind(task);
	expect(() => book.bind({ ...task, kind: "helper" })).toThrow(/conflict/);
	expect(() => book.bind({ ...task, conversationKey: otherKey })).toThrow(/conflict/);
	book.stop("attempt-one");
	expect(() => book.bind(task)).toThrow(/cannot reopen/);
	expect(() => book.stop("unknown")).not.toThrow();
	expect(book.blocks(key)).toBe(false);
});

test("a binding is accepted only for an attempt the process registry retains, and leaves no trace otherwise", () => {
	const f = fixture();
	expect(() => f.taskFinalizations.bind(inline("missing", "run-one"))).toThrow(/Unknown managed attempt/);
	expect(f.taskFinalizations.current(key)).toBeUndefined();
	f.taskFinalizations.stop("missing");
	expect(f.taskFinalizations.blocks(key, inline("missing", "run-one"))).toBe(false);
	f.begin("known");
	f.taskFinalizations.bind(inline("known", "run-one"));
	expect(f.registry.attemptState("known").has("task-finalization")).toBe(true);
	expect(f.taskFinalizations.current(key)?.attemptId).toBe("known");
});

// The full-batch boundary. These tasks are helpers, so an ended one also shows the permanent conversation latch.
const task = helper("attempt", "run");
const declaration = { operationId: "finalize", claim: "claimed-success" as const, declarationToolCallId: "finish" };
const result = { toolCallId: "finish", isError: false };
const staged = (book: TaskFinalizationBook, claim: "claimed-success" | "claimed-failure" = "claimed-success") => {
	book.bind(task);
	book.stage(task, { ...declaration, claim });
};

test("a declaration alone is not a certificate; the actual whole batch latches synchronously before transport", () => {
	const state = new Map<string, unknown>();
	const book = new TaskFinalizationBook(() => state);
	staged(book);
	expect(book.blocks(key)).toBe(false);
	expect(book.pending("attempt")).toBeUndefined();
	let sealed = false;
	expect(
		book.boundary(task, {
			aborted: false,
			toolResults: [result],
			registryThrough: () => {
				sealed = true;
				return 8;
			},
		}),
	).toBe(true);
	expect(sealed).toBe(true);
	expect(state.has("task-finalization")).toBe(true);
	expect(book.pending("attempt")?.registryThrough).toBe(8);
	expect(book.blocks(key)).toBe(true);
	expect(() => book.bind(task)).toThrow(/terminal/);
});

for (const claim of ["claimed-success", "claimed-failure"] as const) {
	for (const failure of ["missing", "duplicate", "declaration-error", "assistant-error", "abort"] as const) {
		test(`${failure} cannot manufacture a ${claim} certificate`, () => {
			const book = new TaskFinalizationBook();
			staged(book, claim);
			const toolResults = {
				missing: [],
				duplicate: [result, result],
				"declaration-error": [{ ...result, isError: true }],
				"assistant-error": [result],
				abort: [result],
			}[failure];
			expect(
				book.boundary(task, {
					aborted: failure === "abort",
					assistantError: failure === "assistant-error",
					toolResults,
					registryThrough: 8,
				}),
			).toBe(false);
			expect(book.pending("attempt")).toBeUndefined();
		});
	}
}

for (const claim of ["claimed-success", "claimed-failure"] as const) {
	for (const siblingError of [false, true]) {
		test(`declared ${claim} is preserved with sibling error=${siblingError}`, () => {
			const book = new TaskFinalizationBook();
			staged(book, claim);
			const toolResults = [result, { toolCallId: "sibling", isError: siblingError }];
			expect(book.boundary(task, { aborted: false, toolResults, registryThrough: 8 })).toBe(true);
			const certificate = book.pending("attempt")!;
			expect(certificate.claim).toBe(claim);
			expect(certificate.toolResults).toEqual(toolResults);
			expect(certificate.declarationBeforeResults).toBe(true);
			expect(book.blocks(key)).toBe(true);
			expect(Object.isFrozen(certificate)).toBe(true);
			expect(Object.isFrozen(certificate.toolResults)).toBe(true);
			for (const observation of certificate.toolResults) expect(Object.isFrozen(observation)).toBe(true);
			// The observations are a retained snapshot, not the caller's array.
			toolResults[1]!.isError = !siblingError;
			expect(certificate.toolResults[1]!.isError).toBe(siblingError);
		});
	}
}

test("a stop is target scoped, repeated requests do not reopen, and a stale run cannot declare", () => {
	const book = new TaskFinalizationBook();
	book.bind(task);
	book.bind({ ...task, attemptId: "next", conversationKey: otherKey });
	book.stop("attempt");
	book.stop("attempt");
	expect(book.blocks(key)).toBe(true);
	expect(book.blocks(otherKey)).toBe(false);
	expect(() => book.stage(task, declaration)).toThrow(/already staged or ended/);
	expect(() =>
		book.boundary({ ...task, runId: "stale" }, { aborted: false, toolResults: [result], registryThrough: 8 }),
	).toThrow(/stale/);
});

for (const terminal of ["stop", "ended"] as const) {
	test(`an inline ${terminal} blocks only the exact active binding, not a fresh or unbound run`, () => {
		const book = new TaskFinalizationBook();
		const active = inline("attempt", "run");
		book.bind(active);
		if (terminal === "stop") book.stop(active.attemptId);
		else {
			book.stage(active, declaration);
			book.boundary(active, { aborted: false, toolResults: [result], registryThrough: 8 });
		}
		expect(book.blocks(key, active)).toBe(true);
		// A stale selected entry must not reject an idle wake or unbound execution.
		expect(book.blocks(key)).toBe(false);
		expect(book.blocks(key, { ...active, runId: "later" })).toBe(false);
		expect(book.blocks(key, { ...active, attemptId: "different" })).toBe(false);
		expect(book.blocks(otherKey, active)).toBe(false);
		const next = { ...active, attemptId: "next", runId: "later" };
		book.bind(next);
		expect(book.blocks(key, next)).toBe(false);
		// Selecting a successor cannot revive the old active run.
		expect(book.blocks(key, active)).toBe(true);
	});
}

for (const terminal of ["stop", "ended"] as const) {
	test(`a helper ${terminal} is permanent across stale selection and unbound ordinary operation`, () => {
		const book = new TaskFinalizationBook();
		book.bind(task);
		if (terminal === "stop") book.stop(task.attemptId);
		else {
			book.stage(task, declaration);
			book.boundary(task, { aborted: false, toolResults: [result], registryThrough: 8 });
		}
		const later = inline("later", "later");
		book.bind(later);
		expect(book.blocks(key)).toBe(true);
		expect(book.blocks(key, later)).toBe(true);
		expect(book.blocks(otherKey)).toBe(false);
	});
}

test("response loss retains the process outbox and latch; reconciliation deduplicates and a superseded winner consumes", async () => {
	const book = new TaskFinalizationBook();
	staged(book);
	book.boundary(task, { aborted: false, toolResults: [result], registryThrough: 8 });
	const certificate = structuredClone(book.pending("attempt"));
	const gate = deferred<void>();
	let sends = 0;
	const send = async () => {
		sends++;
		await gate.promise;
		throw new Error("response lost");
	};
	const first = book.reconcile("attempt", send);
	const second = book.reconcile("attempt", send);
	expect(first).toBe(second);
	gate.resolve();
	await expect(first).rejects.toThrow(/response lost/);
	expect(sends).toBe(1);
	expect(book.pending("attempt")).toEqual(certificate);
	expect(book.blocks(key)).toBe(true);
	await book.reconcile("attempt", async (sent) => {
		expect(sent).toEqual(certificate);
		return "superseded";
	});
	expect(book.pending("attempt")).toBeUndefined();
	expect(book.blocks(key)).toBe(true);
});
