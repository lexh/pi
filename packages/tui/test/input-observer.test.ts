import assert from "node:assert";
import { describe, it } from "node:test";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

for (const [name, createTui] of [
	["TuiMainScreen", (term: VirtualTerminal) => new TuiMainScreen(term)],
	["TuiAltScreen", (term: VirtualTerminal) => new TuiAltScreen(term)],
] as const) {
	describe(`input observer ordering (${name})`, () => {
		it("notifies observer first, then listener, and suppresses focused input if consumed", () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = createTui(terminal);
			const order: string[] = [];

			const off = tui.addInputObserver((data) => {
				order.push(`observe:${JSON.stringify(data)}`);
			});
			tui.addInputListener(() => {
				order.push("listener");
				return { consume: true };
			});
			tui.setFocus({
				render: () => ["focus"],
				invalidate() {},
				handleInput() {
					order.push("focus");
				},
			});

			tui.start();
			terminal.sendInput("\x1b");
			assert.deepStrictEqual(order, ['observe:"\\u001b"', "listener"]);

			off();
			terminal.sendInput("x");
			assert.deepStrictEqual(order, ['observe:"\\u001b"', "listener", "listener"]);
			tui.stop();
		});

		it("notifies observer first and focused component last when listener does not consume", () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = createTui(terminal);
			const order: string[] = [];

			tui.addInputObserver((data) => {
				order.push(`observe:${JSON.stringify(data)}`);
			});
			tui.addInputListener((data) => {
				order.push(`listener:${JSON.stringify(data)}`);
				return undefined;
			});
			tui.setFocus({
				render: () => ["focus"],
				invalidate() {},
				handleInput(data) {
					order.push(`focus:${JSON.stringify(data)}`);
				},
			});

			tui.start();
			terminal.sendInput("\x1b");
			assert.deepStrictEqual(order, ['observe:"\\u001b"', 'listener:"\\u001b"', 'focus:"\\u001b"']);
			tui.stop();
		});

		it("passes original unmodified data to observer even if listener rewrites data", () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = createTui(terminal);
			const order: string[] = [];

			tui.addInputObserver((data) => {
				order.push(`observe:${JSON.stringify(data)}`);
			});
			tui.addInputListener(() => {
				order.push("listener:rewritten");
				return { data: "rewritten" };
			});
			tui.setFocus({
				render: () => ["focus"],
				invalidate() {},
				handleInput(data) {
					order.push(`focus:${JSON.stringify(data)}`);
				},
			});

			tui.start();
			terminal.sendInput("\x1b");
			assert.deepStrictEqual(order, ['observe:"\\u001b"', "listener:rewritten", 'focus:"rewritten"']);
			tui.stop();
		});

		it("iterates a snapshot of observers and does not swallow observer errors", () => {
			const terminal = new VirtualTerminal(80, 24);
			const tui = createTui(terminal);
			const order: string[] = [];

			const off1 = tui.addInputObserver(() => {
				order.push("obs1");
				off1();
				tui.addInputObserver(() => {
					order.push("obs-late");
				});
			});
			tui.addInputObserver(() => {
				order.push("obs2");
			});

			tui.start();
			terminal.sendInput("\x1b");
			assert.deepStrictEqual(order, ["obs1", "obs2"]);

			tui.addInputObserver(() => {
				throw new Error("observer failure must surface");
			});
			assert.throws(() => terminal.sendInput("\x1b"), /observer failure must surface/);
			tui.stop();
		});

		it("keeps observing when another TUI takes over the terminal", () => {
			const terminal = new VirtualTerminal(80, 24);
			const first = createTui(terminal);
			const seen: string[] = [];
			const off = first.addInputObserver((data) => {
				seen.push(data);
			});
			first.start();
			terminal.sendInput("a");
			first.stop();

			const second = createTui(terminal);
			second.start();
			terminal.sendInput("b");
			off();
			terminal.sendInput("c");
			assert.deepStrictEqual(seen, ["a", "b"]);
			second.stop();

			const other = createTui(new VirtualTerminal(80, 24));
			other.addInputObserver(() => {
				seen.push("other");
			});
			const third = createTui(terminal);
			third.start();
			terminal.sendInput("d");
			assert.deepStrictEqual(seen, ["a", "b"]);
			third.stop();
		});
	});
}
