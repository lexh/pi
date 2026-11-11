import { expect, test } from "vitest";
import { type FinalizationBinding, TaskFinalizationBook } from "../src/core/task-finalization.ts";
import { fixture } from "./helpers/managed-process.ts";

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
