import { Container, isViewportTUI, Text } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { ExternalEventCard, ExternalEventDisplayItem } from "../src/core/external-event-projection.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { ExternalEventComponent } from "../src/modes/interactive/components/external-event.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { createInteractiveTui, InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { admission, canonical, savedFixture, selectSyntheticAdmission } from "./helpers/external-events.ts";
import { attachCoordination } from "./helpers/interactive-coordination.ts";
import { createHarness } from "./suite/harness.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

const card: ExternalEventCard = {
	type: "external_event",
	key: "event",
	sourceEntryId: "canonical",
	record: canonical(),
	state: "pending",
	verified: true,
	reason: null,
	location: "shelf",
};

const prototype = InteractiveMode.prototype as unknown as {
	handleEvent(this: unknown, event: AgentSessionEvent): Promise<void>;
};

beforeAll(() => initTheme("dark"));

for (const mode of ["regular", "fullscreen"] as const) {
	for (const focus of ["editor", "dialog"] as const) {
		it(`renders public refreshes without disturbing ${focus} in ${mode}`, async () => {
			const fixture = savedFixture();
			const first = canonical();
			const second = canonical("second", "SECOND_EVENT");
			fixture.manager.appendEntryOnce(first, fixture.root);
			const harness = await createHarness({ sessionManager: fixture.manager });
			const terminal = new VirtualTerminal(100, 30);
			const resize = vi.spyOn(terminal, "resize");
			const ui = createInteractiveTui({ tuiMode: mode, showHardwareCursor: false, logDirectory: "/tmp", terminal });
			const chat = new Container();
			const assistant = new AssistantMessageComponent(undefined, false, getMarkdownTheme(), "Thinking...", 1, []);
			const tool1 = new ToolExecutionComponent(
				"slow",
				"one",
				{},
				{ showImages: false, imageWidthCells: 60, outputPad: 1 },
				undefined,
				ui,
				process.cwd(),
			);
			const tool2 = new ToolExecutionComponent(
				"slow",
				"two",
				{},
				{ showImages: false, imageWidthCells: 60, outputPad: 1 },
				undefined,
				ui,
				process.cwd(),
			);
			const pendingTools = new Map([
				["one", tool1],
				["two", tool2],
			]);
			const editor = new CustomEditor(ui, getEditorTheme(), KeybindingsManager.create());
			editor.setText("draft that must survive");
			editor.handleInput("\u001b[D");
			editor.handleInput("\u001b[D");
			const cursor = editor.getCursor();
			const setText = vi.spyOn(editor, "setText");
			const history = vi.spyOn(editor, "addToHistory");
			const root = new Container();
			root.addChild(chat);
			root.addChild(editor);
			ui.addChild(root);
			if (isViewportTUI(ui)) ui.setLayoutRoot(root);
			ui.setFocus(editor);
			const context = Object.assign(Object.create(InteractiveMode.prototype), {
				runtimeHost: { session: harness.session },
				isInitialized: true,
				chatContainer: chat,
				pendingTools,
				streamingComponent: assistant,
				streamingMessage: undefined,
				maybeShowThinkingDropNotice: vi.fn(),
				maybeShowCacheMissNotice: vi.fn(),
				outputPad: 1,
				toolOutputExpanded: false,
				footer: { invalidate: vi.fn() },
				programStatus: { handleEvent: vi.fn() },
				ui,
			}) as {
				handleEvent(event: AgentSessionEvent): Promise<void>;
			};
			const coordination = attachCoordination(context);
			// The streaming assistant and its tools are the active batch.
			coordination.observe({ type: "message_start", message: assistantMsg("streaming") });
			chat.addChild(assistant);
			chat.addChild(tool1);
			chat.addChild(tool2);
			const unsubscribe = harness.session.subscribe((event) => {
				void context.handleEvent(event);
			});
			ui.start();
			let overlay: ReturnType<typeof ui.showOverlay> | undefined;
			let dialog: CustomEditor | undefined;
			try {
				await terminal.waitForRender();
				if (focus === "dialog") {
					dialog = new CustomEditor(ui, getEditorTheme(), KeybindingsManager.create());
					dialog.setText("dialog draft with cursor");
					dialog.handleInput("\u001b[D");
					dialog.handleInput("\u001b[D");
					dialog.handleInput("\u001b[D");
					overlay = ui.showOverlay(dialog, { width: 35 });
				}
				const dialogText = dialog?.getText();
				const dialogCursor = dialog?.getCursor();
				if (dialogCursor && dialogText) expect(dialogCursor.col).toBeLessThan(dialogText.length);
				const dialogSetText = dialog && vi.spyOn(dialog, "setText");
				const focused = ui.getFocusedComponent();
				if (dialog) expect(focused).toBe(dialog);
				const sessionId = fixture.manager.getSessionId();
				const disposition = {
					recipientIdentity: first.recipientIdentity,
					eventId: first.eventId,
					state: "pending" as const,
					expiresAt: Date.now() + 150,
					reason: null,
				};
				harness.session.refreshExternalEvents({ sessionId, revision: 1, verified: true, events: [disposition] });
				await terminal.waitForRender();
				const key = JSON.stringify([first.recipientIdentity, first.eventId]);
				const original = coordination.getCardComponent(key);
				expect(original).toBeDefined();
				expect(terminal.getViewport().join("\n")).toContain("pending, verified");
				await vi.waitFor(() => expect(original?.render(100).join("\n")).toContain("expired, unverified"), {
					timeout: 2000,
				});
				await terminal.waitForRender();
				expect(terminal.getViewport().join("\n")).toContain("expired, unverified");
				harness.session.refreshExternalEvents({ sessionId, revision: 2, verified: false });
				await terminal.waitForRender();
				expect(terminal.getViewport().join("\n")).toContain("unverified");
				const dropped = { ...disposition, state: "dropped" as const, reason: "gone" };
				harness.session.refreshExternalEvents({ sessionId, revision: 3, verified: true, events: [dropped] });
				await terminal.waitForRender();
				expect(terminal.getViewport().join("\n")).toContain("dropped, verified");
				fixture.manager.appendEntryOnce(second, fixture.root);
				const pendingSecond = { ...disposition, eventId: second.eventId, expiresAt: null };
				harness.session.refreshExternalEvents({
					sessionId,
					revision: 4,
					verified: true,
					events: [dropped, pendingSecond],
				});
				await terminal.waitForRender();
				expect(coordination.getCardComponent(key)).toBe(original);
				expect(chat.children.filter((child) => child === original)).toHaveLength(1);
				expect(
					coordination.getCardComponent(JSON.stringify([second.recipientIdentity, second.eventId])),
				).toBeDefined();
				selectSyntheticAdmission(fixture.manager, admission(first, fixture.selected));
				const following = userMsg("following admission");
				coordination.observe({ type: "message_start", message: following });
				const next = new Text("following admission");
				chat.addChild(next);
				fixture.manager.appendMessage(following);
				harness.session.refreshExternalEvents();
				await terminal.waitForRender();
				expect(coordination.getCardComponent(key)).toBe(original);
				expect(chat.children.filter((child) => child === original)).toHaveLength(1);
				expect(chat.children.indexOf(original!)).toBeLessThan(chat.children.indexOf(next));
				expect(original?.render(100).join("\n")).toContain("admitted");
				expect(editor.getText()).toBe("draft that must survive");
				expect(editor.getCursor()).toEqual(cursor);
				expect(setText).not.toHaveBeenCalled();
				expect(history).not.toHaveBeenCalled();
				expect(ui.getFocusedComponent()).toBe(focused);
				if (dialog) {
					expect(dialog.getText()).toBe(dialogText);
					expect(dialog.getCursor()).toEqual(dialogCursor);
					expect(dialogSetText).not.toHaveBeenCalled();
				}
				expect(harness.faux.state.callCount).toBe(0);
				expect(resize).not.toHaveBeenCalled();
				expect(pendingTools.get("one")).toBe(tool1);
				expect(pendingTools.get("two")).toBe(tool2);
				expect(chat.children.indexOf(assistant)).toBeLessThan(chat.children.indexOf(tool1));
				expect(chat.children.indexOf(tool1)).toBeLessThan(chat.children.indexOf(tool2));
				expect(chat.children.filter((child) => child === tool1)).toHaveLength(1);
				expect(chat.children.filter((child) => child === tool2)).toHaveLength(1);
				await context.handleEvent({ type: "message_end", message: assistantMsg("finished assistant") });
				harness.session.refreshExternalEvents();
				await terminal.waitForRender();
				expect(pendingTools.get("one")).toBe(tool1);
				await context.handleEvent({
					type: "tool_execution_end",
					toolCallId: "one",
					toolName: "slow",
					result: { content: [{ type: "text", text: "first result" }], details: undefined },
					isError: false,
				});
				harness.session.refreshExternalEvents();
				await terminal.waitForRender();
				expect(pendingTools.get("two")).toBe(tool2);
				expect(chat.children.indexOf(assistant)).toBeLessThan(chat.children.indexOf(tool1));
				expect(chat.children.indexOf(tool1)).toBeLessThan(chat.children.indexOf(tool2));
				await context.handleEvent({
					type: "tool_execution_end",
					toolCallId: "two",
					toolName: "slow",
					result: { content: [{ type: "text", text: "second result" }], details: undefined },
					isError: false,
				});
				expect(pendingTools.size).toBe(0);
				expect(tool1.render(100).join("\n")).toContain("first result");
				expect(tool2.render(100).join("\n")).toContain("second result");
				if (overlay) {
					overlay.hide();
					expect(ui.getFocusedComponent()).toBe(editor);
					expect(editor.getText()).toBe("draft that must survive");
				}
			} finally {
				overlay?.hide();
				unsubscribe();
				ui.stop();
				harness.cleanup();
				fixture.cleanup();
			}
		});
	}
}

it("reopens and preserves one keyed card through manual, repeated, and boundary compaction", async () => {
	const fixture = savedFixture();
	fixture.manager.appendEntryOnce(canonical(), fixture.root);
	const reopened = SessionManager.open(fixture.manager.getSessionFile()!);
	const harness = await createHarness({ sessionManager: reopened });
	const terminal = new VirtualTerminal(100, 30);
	const ui = createInteractiveTui({ tuiMode: "regular", showHardwareCursor: false, logDirectory: "/tmp", terminal });
	const chat = new Container();
	const editor = new CustomEditor(ui, getEditorTheme(), KeybindingsManager.create());
	ui.addChild(chat);
	ui.addChild(editor);
	ui.setFocus(editor);
	const context = Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: { session: harness.session },
		renderer: ui,
		ui,
		editor,
		chatContainer: chat,
		isInitialized: true,
		pendingTools: new Map(),
		entriesRenderedByBoundaryCompaction: new Set<string>(),
		toolOutputExpanded: false,
		outputPad: 1,
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		footer: { invalidate: vi.fn() },
		programStatus: { handleEvent: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		getMarkdownTransformers: () => [],
		renderProjectTrustWarningIfNeeded: vi.fn(),
		clearStatusIndicator: vi.fn(),
		flushCompactionQueue: vi.fn(),
	}) as {
		renderInitialMessages(): void;
		handleEvent(event: AgentSessionEvent): Promise<void>;
		entriesRenderedByBoundaryCompaction: Set<string>;
	};
	const coordination = attachCoordination(context);
	const unsubscribe = harness.session.subscribe((event) => {
		void context.handleEvent(event);
	});
	ui.start();
	try {
		context.renderInitialMessages();
		await terminal.waitForRender();
		editor.handleInput("\x1b[A");
		expect(editor.getText()).toBe("ordinary root");
		editor.setText("");
		const key = JSON.stringify(["recipient", "event"]);
		const original = coordination.getCardComponent(key);
		expect(original).toBeDefined();
		expect(original?.render(100).join("\n")).toContain("unverified");
		const assertOne = () => {
			expect(coordination.getCardComponent(key)).toBe(original);
			expect(chat.children.filter((child) => child === original)).toHaveLength(1);
		};
		for (const summary of ["manual one", "manual two"]) {
			reopened.appendCompaction(summary, null, 100);
			await context.handleEvent({
				type: "compaction_end",
				reason: "manual",
				result: { summary, firstKeptEntryId: fixture.root, tokensBefore: 100 },
				aborted: false,
				willRetry: false,
			});
			assertOne();
			harness.session.refreshExternalEvents();
			await terminal.waitForRender();
			assertOne();
		}
		const id = reopened.appendCompaction("boundary", null, 100);
		const afterId = reopened.appendMessage(userMsg("after boundary"));
		const entry = reopened.getEntry(id);
		if (!entry || entry.type !== "compaction") throw new Error("missing boundary compaction");
		await context.handleEvent({ type: "entry_appended", entry });
		assertOne();
		expect(context.entriesRenderedByBoundaryCompaction.has(afterId)).toBe(true);
		const afterEntry = reopened.getEntry(afterId);
		if (!afterEntry) throw new Error("missing post-compaction entry");
		await context.handleEvent({ type: "entry_appended", entry: afterEntry });
		expect(context.entriesRenderedByBoundaryCompaction.has(afterId)).toBe(false);
		assertOne();
		harness.session.refreshExternalEvents();
		await terminal.waitForRender();
		assertOne();
		editor.handleInput("\x1b[A");
		expect(editor.getText()).not.toContain("UNREAD_BODY_7d81");
		expect(editor.getText()).not.toContain("ADMITTED_BODY_c9f2");
		expect(harness.faux.state.callCount).toBe(0);
	} finally {
		unsubscribe();
		ui.stop();
		harness.cleanup();
		fixture.cleanup();
	}
});

describe("external event live integration", () => {
	function liveFixture() {
		const user = userMsg("root");
		const final = assistantMsg("final");
		const entries: SessionEntry[] = [
			{ type: "message", id: "root", parentId: null, timestamp: "2025-01-01T00:00:00Z", message: user },
		];
		let inlineBeforeAssistant = false;
		const session = {
			retryAttempt: 0,
			sessionManager: { getEntries: () => entries, buildContextEntries: () => entries },
			getExternalEventView: (visible: readonly SessionEntry[]): ExternalEventDisplayItem[] => {
				const items: ExternalEventDisplayItem[] = visible.map((entry) => ({ type: "entry", entry }));
				const at = items.findIndex((item) => item.type === "entry" && item.entry.id === "assistant");
				if (inlineBeforeAssistant && at >= 0) items.splice(at, 0, { ...card, location: "inline" });
				else items.push(card);
				return items;
			},
		};
		const chatContainer = new Container();
		const context = Object.assign(Object.create(InteractiveMode.prototype), {
			runtimeHost: { session },
			chatContainer,
			outputPad: 1,
			toolOutputExpanded: false,
			footer: { invalidate: vi.fn() },
			ui: { requestRender: vi.fn() },
		});
		const coordination = attachCoordination(context);
		// The live flow mounts each message after it starts.
		const userComponent = new Text("user", 0, 0);
		coordination.observe({ type: "message_start", message: user });
		chatContainer.addChild(userComponent);
		const assistant = new Text("assistant", 0, 0);
		const tool1 = Object.assign(new Text("tool 1", 0, 0), { setArgsComplete: vi.fn(), updateResult: vi.fn() });
		const tool2 = Object.assign(new Text("tool 2", 0, 0), { setArgsComplete: vi.fn(), updateResult: vi.fn() });
		coordination.observe({ type: "message_start", message: assistantMsg("streaming") });
		for (const child of [assistant, tool1, tool2]) chatContainer.addChild(child);
		const persistFinal = () =>
			entries.push({
				type: "message",
				id: "assistant",
				parentId: "root",
				timestamp: "2025-01-01T00:00:01Z",
				message: final,
			});
		const placeInlineBeforeAssistant = () => {
			inlineBeforeAssistant = true;
		};
		return {
			context,
			coordination,
			chatContainer,
			userComponent,
			assistant,
			tool1,
			tool2,
			final,
			persistFinal,
			placeInlineBeforeAssistant,
		};
	}

	it("refreshes inside message_end before persistence without splitting the tool batch", async () => {
		const f = liveFixture();
		const pendingTools = new Map([
			["one", f.tool1],
			["two", f.tool2],
		]);
		const streamingComponent = Object.assign(f.assistant, { updateContent: () => f.coordination.refresh() });
		Object.assign(f.context, {
			isInitialized: true,
			programStatus: { handleEvent: vi.fn() },
			streamingComponent,
			streamingMessage: f.final,
			pendingTools,
			maybeShowThinkingDropNotice: vi.fn(),
			maybeShowCacheMissNotice: vi.fn(),
		});
		await prototype.handleEvent.call(f.context, { type: "message_end", message: f.final });
		const original = f.coordination.getCardComponent(card.key);
		expect(f.chatContainer.children).toEqual([f.userComponent, original, f.assistant, f.tool1, f.tool2]);
		expect(pendingTools.size).toBe(2);
		expect(f.context.streamingComponent).toBeUndefined();
		f.persistFinal();
		f.coordination.refresh();
		expect(f.coordination.getCardComponent(card.key)).toBe(original);
		await prototype.handleEvent.call(f.context, {
			type: "tool_execution_end",
			toolCallId: "one",
			toolName: "tool",
			result: { content: [{ type: "text", text: "first" }], details: undefined },
			isError: false,
		});
		f.coordination.refresh();
		expect(pendingTools.get("two")).toBe(f.tool2);
		expect(f.chatContainer.children).toEqual([f.userComponent, original, f.assistant, f.tool1, f.tool2]);
		await prototype.handleEvent.call(f.context, {
			type: "tool_execution_end",
			toolCallId: "two",
			toolName: "tool",
			result: { content: [{ type: "text", text: "second" }], details: undefined },
			isError: false,
		});
		expect(f.tool1.updateResult).toHaveBeenCalledOnce();
		expect(f.tool2.updateResult).toHaveBeenCalledOnce();
		// message_end anchored the persisted assistant entry to the streamed component.
		await prototype.handleEvent.call(f.context, { type: "turn_end", message: f.final, toolResults: [] });
		f.placeInlineBeforeAssistant();
		f.coordination.refresh();
		expect(f.chatContainer.children).toEqual([f.userComponent, original, f.assistant, f.tool1, f.tool2]);
	});

	it("keeps the active batch together before persistence and places cards at the end after the turn", () => {
		const f = liveFixture();
		f.coordination.refresh();
		const original = f.coordination.getCardComponent(card.key);
		expect(original).toBeInstanceOf(ExternalEventComponent);
		expect(f.chatContainer.children).toEqual([f.userComponent, original, f.assistant, f.tool1, f.tool2]);
		expect(f.context.ui.requestRender).toHaveBeenCalledOnce();
		f.coordination.observe({ type: "message_end", message: f.final });
		f.persistFinal();
		f.coordination.refresh();
		expect(f.chatContainer.children).toEqual([f.userComponent, original, f.assistant, f.tool1, f.tool2]);
		f.coordination.observe({ type: "turn_end", message: f.final, toolResults: [] });
		f.coordination.refresh();
		expect(f.coordination.getCardComponent(card.key)).toBe(original);
		expect(f.chatContainer.children).toEqual([f.userComponent, f.assistant, f.tool1, f.tool2, original]);
	});
});
