import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
	type AutocompleteProvider,
	type Component,
	Container,
	type EditorComponent,
	type EditorTheme,
	type TUI,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSession } from "../src/core/agent-session.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { FullscreenExitOutput, TuiMode } from "../src/core/settings-manager.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { InteractiveCoordination, isCoordinationEscape } from "../src/modes/interactive/interactive-coordination.ts";
import {
	createInteractiveTui,
	createInteractiveTuiReference,
	InteractiveMode,
} from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createCoordinationHarness } from "./helpers/coordination.ts";

interface InteractiveCancelFixture {
	terminal: VirtualTerminal;
	mode: Record<string, unknown> & {
		runtimeHost: {
			session: AgentSession;
			isBusy: () => boolean;
			fork: (id: string) => Promise<{ cancelled: boolean; selectedText?: string }>;
		};
		renderer: ReturnType<typeof createInteractiveTui>;
		ui: TUI;
		defaultEditor: CustomEditor;
		editor: EditorComponent;
		editorContainer: Container;
		statusContainer: Container;
		chatContainer: Container;
		extensionDialogs: Array<{ component: Component; blocked: unknown }>;
		extensionTerminalInputSubscriptions: Set<{
			handler: (data: string) => { consume?: boolean; data?: string } | undefined;
			unsubscribe: () => void;
		}>;
		keybindings: KeybindingsManager;
		lastEscapeTime: number;
		isBashMode: boolean;
		options: { tuiMode: TuiMode };
		fullscreenLayoutRoot: Component;
		setupKeyHandlers(): void;
		showExtensionSelector(title: string, options: string[]): Promise<string | undefined>;
		showExtensionConfirm(title: string, message: string): Promise<boolean>;
		showExtensionInput(title: string, placeholder?: string): Promise<string | undefined>;
		showExtensionEditor(title: string, prefill?: string): Promise<string | undefined>;
		showExtensionCustom<T>(
			factory: (tui: TUI, theme: unknown, kb: KeybindingsManager, done: (res: T) => void) => Component,
			options?: Record<string, unknown>,
		): Promise<T>;
		setCustomEditorComponent(
			factory: ((tui: TUI, theme: EditorTheme, kb: KeybindingsManager) => EditorComponent) | undefined,
		): void;
		addExtensionTerminalInputListener(
			handler: (data: string) => { consume?: boolean; data?: string } | undefined,
		): () => void;
		rebindExtensionTerminalInputListeners(): void;
		clearExtensionTerminalInputListeners(): void;
		showThinkingSelector(): void;
		showTreeSelector(initialId?: string): void;
		showUserMessageSelector(): void;
		switchTuiMode(mode: TuiMode, restoreProgress?: boolean, startRenderer?: boolean): boolean;
		stopInteractiveTui(output: FullscreenExitOutput): void;
		stop(output?: FullscreenExitOutput): void;
	};
	cleanup: () => void;
}

function createInteractiveCancelFixture(
	session: AgentSession,
	tuiMode: TuiMode = "regular",
	keybindings = new KeybindingsManager(),
): InteractiveCancelFixture {
	initTheme("dark", false);
	const terminal = new VirtualTerminal(100, 30);
	const renderer = createInteractiveTui({
		tuiMode,
		showHardwareCursor: false,
		logDirectory: "/tmp",
		terminal,
	});
	const editorContainer = new Container();
	const statusContainer = new Container();
	const chatContainer = new Container();
	const fullscreenLayoutRoot = new Container();
	fullscreenLayoutRoot.addChild(chatContainer);
	fullscreenLayoutRoot.addChild(editorContainer);

	const proto = InteractiveMode.prototype as unknown as Record<string, unknown>;
	const rawMode: Record<string, unknown> = Object.create(InteractiveMode.prototype);

	const ui = createInteractiveTuiReference(() => rawMode.renderer as ReturnType<typeof createInteractiveTui>);
	const defaultEditor = new CustomEditor(ui, getEditorTheme(), keybindings, {
		paddingX: 1,
		autocompleteMaxVisible: 5,
		embedWorkingStatus: true,
	});
	editorContainer.addChild(defaultEditor);
	renderer.addChild(chatContainer);
	renderer.addChild(editorContainer);
	if (tuiMode === "fullscreen") {
		(renderer as unknown as { setLayoutRoot(root: Component): void }).setLayoutRoot(fullscreenLayoutRoot);
	}
	renderer.setFocus(defaultEditor);

	Object.assign(rawMode, {
		runtimeHost: {
			session,
			isBusy: () => false,
			fork: async () => ({ cancelled: false, selectedText: "forked" }),
		},
		renderer,
		ui,
		defaultEditor,
		editor: defaultEditor,
		editorContainer,
		statusContainer,
		chatContainer,
		fullscreenLayoutRoot,
		extensionDialogs: [],
		extensionOverlays: new Map(),
		extensionTerminalInputSubscriptions: new Set(),
		keybindings,
		lastEscapeTime: 0,
		isBashMode: false,
		isInitialized: true,
		options: { tuiMode },
		programStatus: { setBlocked: vi.fn(), handleEvent: vi.fn() },
		themeController: { rebindTui: vi.fn(), disableAutoSync: vi.fn() },
		footer: { dispose: vi.fn(), invalidate: vi.fn() },
		footerDataProvider: { dispose: vi.fn(), setExtensionStatus: vi.fn() },
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		toggleToolOutputExpansion: vi.fn(),
		unregisterSignalHandlers: vi.fn(),
	});

	const proxyMode = new Proxy(rawMode, {
		get(target, key, receiver) {
			if (key in target) return Reflect.get(target, key, receiver);
			const value = proto[key as string];
			return typeof value === "function" ? value.bind(receiver) : value;
		},
		set(target, key, value, receiver) {
			return Reflect.set(target, key, value, receiver);
		},
	}) as InteractiveCancelFixture["mode"];

	new InteractiveCoordination({
		runtimeHost: () => proxyMode.runtimeHost as never,
		ui: () => ui,
		chat: () => chatContainer,
		outputPad: () => 1,
		toolOutputExpanded: () => false,
		showStatus: vi.fn(),
		showError: vi.fn(),
		invalidateFooter: vi.fn(),
	}).attach();
	proxyMode.setupKeyHandlers();
	renderer.start();

	return {
		terminal,
		mode: proxyMode,
		cleanup: () => {
			try {
				proxyMode.stop("resume-hint");
			} catch {
				// ignore cleanup stop errors
			}
		},
	};
}

function seedDraftAndQueues(session: AgentSession, editor: EditorComponent) {
	editor.setText("UNSENT_DRAFT_TEXT");
	(session as unknown as { _steeringMessages: string[]; _followUpMessages: string[] })._steeringMessages.push(
		"QUEUED_STEER_MSG",
	);
	(session as unknown as { _steeringMessages: string[]; _followUpMessages: string[] })._followUpMessages.push(
		"QUEUED_FOLLOWUP_MSG",
	);
}

function expectDraftAndQueuesPreserved(session: AgentSession, editor: EditorComponent) {
	expect(editor.getText()).toBe("UNSENT_DRAFT_TEXT");
	expect(session.getSteeringMessages()).toEqual(["QUEUED_STEER_MSG"]);
	expect(session.getFollowUpMessages()).toEqual(["QUEUED_FOLLOWUP_MSG"]);
}

describe("InteractiveMode pre-routing Escape coordination cancellation", () => {
	beforeAll(() => initTheme("dark", false));

	it("isCoordinationEscape matches physical Escape, excludes key-release packets, and ignores non-Escape keys", () => {
		expect(isCoordinationEscape("\x1b")).toBe(true);
		expect(isCoordinationEscape("\x1b[27u")).toBe(true);
		// Key-release packet for Escape must be ignored
		expect(isCoordinationEscape("\x1b[27;1:3u")).toBe(false);
		expect(isCoordinationEscape("a")).toBe(false);
		expect(isCoordinationEscape("\x03")).toBe(false);
	});

	it.each(["regular", "fullscreen"] as const)(
		"Row 1 (%s): default editor with nonempty draft, empty double-Esc, autocomplete open, and remapped app.interrupt",
		async (tuiMode) => {
			const coord = await createCoordinationHarness();
			const { harness, coordinator, scheduler } = coord;
			scheduler.bind(coordinator);
			const cancelSpy = vi.spyOn(coordinator, "cancelPermissions");

			// Remap app.interrupt to ctrl+c to prove physical Esc still revokes coordination permission
			const customKb = new KeybindingsManager({ "app.interrupt": "ctrl+c" });
			const uiFixture = createInteractiveCancelFixture(harness.session, tuiMode, customKb);

			try {
				// 1a. Nonempty draft + queues with app.interrupt remapped to ctrl+c
				const receipt1 = await scheduler.grant({ kind: "job", attemptId: "job-row1-draft" });
				seedDraftAndQueues(harness.session, uiFixture.mode.editor);

				let observedRevokedInEditor = false;
				const origHandleInput = uiFixture.mode.defaultEditor.handleInput.bind(uiFixture.mode.defaultEditor);
				vi.spyOn(uiFixture.mode.defaultEditor, "handleInput").mockImplementation((data: string) => {
					if (data === "\x1b") {
						observedRevokedInEditor =
							scheduler.inspect().grants.find((g) => g.grantId === receipt1.grantId)?.state === "revoked";
					}
					origHandleInput(data);
				});

				// Non-Esc and key-release Esc must not cancel
				uiFixture.terminal.sendInput("\x1b[27;1:3u");
				expect(scheduler.inspect().permissionEpoch).toBe(0);
				expect(cancelSpy).toHaveBeenCalledTimes(0);

				// Physical Esc revokes before editor.handleInput runs
				uiFixture.terminal.sendInput("\x1b");
				expect(observedRevokedInEditor).toBe(true);
				expect(scheduler.inspect().permissionEpoch).toBe(1);
				expect(cancelSpy).toHaveBeenCalledTimes(1);
				expectDraftAndQueuesPreserved(harness.session, uiFixture.mode.editor);

				// 1b. Restore default app.interrupt ("escape") and open autocomplete via actual terminal input "/"
				customKb.setUserBindings({});
				const acProvider: AutocompleteProvider = {
					getSuggestions: async () => ({
						items: [{ value: "/help", label: "/help" }],
						prefix: "/",
					}),
					applyCompletion: (lines, cursorLine, cursorCol) => ({
						lines,
						cursorLine,
						cursorCol,
					}),
				};
				uiFixture.mode.defaultEditor.setAutocompleteProvider(acProvider);
				uiFixture.mode.editor.setText("");
				uiFixture.terminal.sendInput("/");
				await vi.waitFor(() => {
					expect(uiFixture.mode.defaultEditor.isShowingAutocomplete()).toBe(true);
				});

				const receiptAc = await scheduler.grant({ kind: "job", attemptId: "job-row1-autocomplete" });
				uiFixture.terminal.sendInput("\x1b");
				expect(scheduler.inspect().grants.find((g) => g.grantId === receiptAc.grantId)?.state).toBe("revoked");
				expect(uiFixture.mode.defaultEditor.isShowingAutocomplete()).toBe(false);
				expect(uiFixture.mode.editor.getText()).toBe("/");
				expect(harness.session.getSteeringMessages()).toEqual(["QUEUED_STEER_MSG"]);
				expect(harness.session.getFollowUpMessages()).toEqual(["QUEUED_FOLLOWUP_MSG"]);
				expect(scheduler.inspect().permissionEpoch).toBe(2);
				expect(cancelSpy).toHaveBeenCalledTimes(2);

				// 1c. Empty editor double-Esc opens tree selector; second Esc does not send duplicate cancel RPC
				const receipt2 = await scheduler.grant({ kind: "job", attemptId: "job-row1-double-esc" });
				uiFixture.mode.editor.setText("");
				harness.settingsManager.applyOverrides({ doubleEscapeAction: "tree" });

				uiFixture.terminal.sendInput("\x1b");
				expect(scheduler.inspect().grants.find((g) => g.grantId === receipt2.grantId)?.state).toBe("revoked");
				expect(scheduler.inspect().permissionEpoch).toBe(3);
				expect(cancelSpy).toHaveBeenCalledTimes(3);

				// Second Esc within 500ms opens tree selector and does NOT increment permissionEpoch again
				uiFixture.terminal.sendInput("\x1b");
				expect(scheduler.inspect().permissionEpoch).toBe(3);
				expect(cancelSpy).toHaveBeenCalledTimes(3);
				expect(uiFixture.mode.renderer.getFocusedComponent()).not.toBe(uiFixture.mode.defaultEditor);
			} finally {
				uiFixture.cleanup();
				coord.cleanup();
			}
		},
	);

	it.each(["regular", "fullscreen"] as const)(
		"Row 2 (%s): custom editor consuming Esc and built-in selectors (thinking, tree, user-message)",
		async (tuiMode) => {
			const coord = await createCoordinationHarness();
			const { harness, coordinator, scheduler } = coord;
			scheduler.bind(coordinator);
			const cancelSpy = vi.spyOn(coordinator, "cancelPermissions");
			const uiFixture = createInteractiveCancelFixture(harness.session, tuiMode, new KeybindingsManager());

			try {
				seedDraftAndQueues(harness.session, uiFixture.mode.editor);

				// 2a. Custom editor that consumes Esc without calling base
				const receiptCustomEd = await scheduler.grant({ kind: "job", attemptId: "job-row2-custom-ed" });
				let customEditorSawRevoked = false;
				let customEditorConsumedEsc = false;

				uiFixture.mode.setCustomEditorComponent((tui, edTheme, kb) => {
					const ed = new CustomEditor(tui, edTheme, kb);
					ed.handleInput = (data: string) => {
						if (data === "\x1b") {
							customEditorConsumedEsc = true;
							customEditorSawRevoked =
								scheduler.inspect().grants.find((g) => g.grantId === receiptCustomEd.grantId)?.state ===
								"revoked";
							return;
						}
					};
					return ed;
				});

				uiFixture.terminal.sendInput("\x1b");
				expect(customEditorConsumedEsc).toBe(true);
				expect(customEditorSawRevoked).toBe(true);
				expect(scheduler.inspect().permissionEpoch).toBe(1);
				expect(cancelSpy).toHaveBeenCalledTimes(1);
				expectDraftAndQueuesPreserved(harness.session, uiFixture.mode.editor);

				// Restore default editor
				uiFixture.mode.setCustomEditorComponent(undefined);

				// 2b. Built-in thinking selector
				const receiptThinking = await scheduler.grant({ kind: "job", attemptId: "job-row2-thinking" });
				uiFixture.mode.showThinkingSelector();
				expect(uiFixture.mode.renderer.getFocusedComponent()).not.toBe(uiFixture.mode.editor);

				uiFixture.terminal.sendInput("\x1b");
				expect(scheduler.inspect().grants.find((g) => g.grantId === receiptThinking.grantId)?.state).toBe(
					"revoked",
				);
				expect(scheduler.inspect().permissionEpoch).toBe(2);
				expect(cancelSpy).toHaveBeenCalledTimes(2);
				expect(uiFixture.mode.renderer.getFocusedComponent()).toBe(uiFixture.mode.editor);
				expectDraftAndQueuesPreserved(harness.session, uiFixture.mode.editor);

				// 2c. Built-in tree selector
				const receiptTree = await scheduler.grant({ kind: "job", attemptId: "job-row2-tree" });
				uiFixture.mode.showTreeSelector();
				expect(uiFixture.mode.renderer.getFocusedComponent()).not.toBe(uiFixture.mode.editor);

				uiFixture.terminal.sendInput("\x1b");
				expect(scheduler.inspect().grants.find((g) => g.grantId === receiptTree.grantId)?.state).toBe("revoked");
				expect(scheduler.inspect().permissionEpoch).toBe(3);
				expect(cancelSpy).toHaveBeenCalledTimes(3);
				expect(uiFixture.mode.renderer.getFocusedComponent()).toBe(uiFixture.mode.editor);
				expectDraftAndQueuesPreserved(harness.session, uiFixture.mode.editor);

				// 2d. Built-in user message (history/fork) selector
				const receiptHistory = await scheduler.grant({ kind: "job", attemptId: "job-row2-history" });
				uiFixture.mode.showUserMessageSelector();
				expect(uiFixture.mode.renderer.getFocusedComponent()).not.toBe(uiFixture.mode.editor);

				uiFixture.terminal.sendInput("\x1b");
				expect(scheduler.inspect().grants.find((g) => g.grantId === receiptHistory.grantId)?.state).toBe("revoked");
				expect(scheduler.inspect().permissionEpoch).toBe(4);
				expect(cancelSpy).toHaveBeenCalledTimes(4);
				expect(uiFixture.mode.renderer.getFocusedComponent()).toBe(uiFixture.mode.editor);
				expectDraftAndQueuesPreserved(harness.session, uiFixture.mode.editor);
			} finally {
				uiFixture.cleanup();
				coord.cleanup();
			}
		},
	);

	it.each(["regular", "fullscreen"] as const)(
		"Row 3 (%s): extension select, confirm, input, multiline editor, nested inline custom, and model permission/wait unwind",
		async (tuiMode) => {
			const waitEntered = Promise.withResolvers<void>();
			const coord = await createCoordinationHarness({
				extensionFactories: [
					(pi) => {
						pi.registerTool({
							name: "wait_under_dialog",
							label: "Wait Under Dialog",
							description: "waits for peer",
							parameters: Type.Object({}),
							async execute() {
								const waitPromise = coord.scheduler.wait(
									{ kind: "job", attemptId: "job-wait-dialog" },
									Date.now() + 60_000,
								);
								waitEntered.resolve();
								const outcome = await waitPromise;
								return {
									content: [{ type: "text", text: `outcome:${outcome.status}` }],
									details: { outcome },
								};
							},
						});
					},
				],
			});
			const { harness, coordinator, scheduler } = coord;
			scheduler.bind(coordinator);
			const cancelSpy = vi.spyOn(coordinator, "cancelPermissions");
			const uiFixture = createInteractiveCancelFixture(harness.session, tuiMode);

			try {
				seedDraftAndQueues(harness.session, uiFixture.mode.editor);

				// 3a. Extension select
				const receiptSelect = await scheduler.grant({ kind: "job", attemptId: "job-row3-select" });
				const selectPromise = uiFixture.mode.showExtensionSelector("Choose", ["A", "B"]);
				uiFixture.terminal.sendInput("\x1b");
				await expect(selectPromise).resolves.toBeUndefined();
				expect(scheduler.inspect().grants.find((g) => g.grantId === receiptSelect.grantId)?.state).toBe("revoked");
				expect(scheduler.inspect().permissionEpoch).toBe(1);
				expect(cancelSpy).toHaveBeenCalledTimes(1);
				expectDraftAndQueuesPreserved(harness.session, uiFixture.mode.editor);

				// 3b. Extension confirm
				const receiptConfirm = await scheduler.grant({ kind: "job", attemptId: "job-row3-confirm" });
				const confirmPromise = uiFixture.mode.showExtensionConfirm("Confirm", "Are you sure?");
				uiFixture.terminal.sendInput("\x1b");
				await expect(confirmPromise).resolves.toBe(false);
				expect(scheduler.inspect().grants.find((g) => g.grantId === receiptConfirm.grantId)?.state).toBe("revoked");
				expect(scheduler.inspect().permissionEpoch).toBe(2);
				expect(cancelSpy).toHaveBeenCalledTimes(2);
				expectDraftAndQueuesPreserved(harness.session, uiFixture.mode.editor);

				// 3c. Extension input
				const receiptInput = await scheduler.grant({ kind: "job", attemptId: "job-row3-input" });
				const inputPromise = uiFixture.mode.showExtensionInput("Enter value", "placeholder");
				uiFixture.terminal.sendInput("\x1b");
				await expect(inputPromise).resolves.toBeUndefined();
				expect(scheduler.inspect().grants.find((g) => g.grantId === receiptInput.grantId)?.state).toBe("revoked");
				expect(scheduler.inspect().permissionEpoch).toBe(3);
				expect(cancelSpy).toHaveBeenCalledTimes(3);
				expectDraftAndQueuesPreserved(harness.session, uiFixture.mode.editor);

				// 3d. Extension multiline editor
				const receiptEditor = await scheduler.grant({ kind: "job", attemptId: "job-row3-editor" });
				const editorPromise = uiFixture.mode.showExtensionEditor("Edit text", "initial");
				uiFixture.terminal.sendInput("\x1b");
				await expect(editorPromise).resolves.toBeUndefined();
				expect(scheduler.inspect().grants.find((g) => g.grantId === receiptEditor.grantId)?.state).toBe("revoked");
				expect(scheduler.inspect().permissionEpoch).toBe(4);
				expect(cancelSpy).toHaveBeenCalledTimes(4);
				expectDraftAndQueuesPreserved(harness.session, uiFixture.mode.editor);

				// 3e. Nested inline custom screens + model-blocking auth UI
				const receiptNested = await scheduler.grant({ kind: "job", attemptId: "job-row3-nested" });
				let innerSawRevoked = false;
				const outerCustom = uiFixture.mode.showExtensionCustom<string>(
					(_tui, _theme, _kb, done) => ({
						render: () => ["outer-custom"],
						invalidate: () => {},
						handleInput: (data: string) => {
							if (data === "\x1b") done("outer-closed");
						},
					}),
					{ blocked: { kind: "auth", message: "Auth required" } },
				);
				const innerCustom = uiFixture.mode.showExtensionCustom<string>((_tui, _theme, _kb, done) => ({
					render: () => ["inner-custom"],
					invalidate: () => {},
					handleInput: (data: string) => {
						if (data === "\x1b") {
							innerSawRevoked =
								scheduler.inspect().grants.find((g) => g.grantId === receiptNested.grantId)?.state ===
								"revoked";
							done("inner-closed");
						}
					},
				}));

				await vi.waitFor(() => {
					expect(uiFixture.mode.extensionDialogs).toHaveLength(2);
				});

				// First Esc revokes grant and closes inner custom screen
				uiFixture.terminal.sendInput("\x1b");
				await expect(innerCustom).resolves.toBe("inner-closed");
				expect(innerSawRevoked).toBe(true);
				expect(scheduler.inspect().permissionEpoch).toBe(5);
				expect(cancelSpy).toHaveBeenCalledTimes(5);

				// Second Esc closes outer custom screen with no duplicate cancel RPC
				uiFixture.terminal.sendInput("\x1b");
				await expect(outerCustom).resolves.toBe("outer-closed");
				expect(scheduler.inspect().permissionEpoch).toBe(5);
				expect(cancelSpy).toHaveBeenCalledTimes(5);
				expectDraftAndQueuesPreserved(harness.session, uiFixture.mode.editor);

				// 3f. Active model wait under an overlay: Esc unwinds wait result with zero next automatic calls
				harness.setResponses([
					fauxAssistantMessage(fauxToolCall("wait_under_dialog", {}), { stopReason: "toolUse" }),
					fauxAssistantMessage("should not run after wait interrupted by overlay Esc"),
				]);
				// Clear queued messages before starting run so we test wait unwind cleanly
				(
					harness.session as unknown as { _steeringMessages: string[]; _followUpMessages: string[] }
				)._steeringMessages.length = 0;
				(
					harness.session as unknown as { _steeringMessages: string[]; _followUpMessages: string[] }
				)._followUpMessages.length = 0;

				const fenceBeforeWait = harness.session.runtimeLifecycle.capture();
				const runPromise = harness.session.prompt("start wait tool");
				await waitEntered.promise;

				// Open an overlay on top of the active wait
				const overlayPromise = uiFixture.mode.showExtensionCustom<string>(
					(_tui, _theme, _kb, done) => ({
						render: () => ["wait-overlay"],
						invalidate: () => {},
						handleInput: (data: string) => {
							if (data === "\x1b") done("overlay-dismissed");
						},
					}),
					{ overlay: true },
				);
				await vi.waitFor(() => {
					expect(uiFixture.mode.renderer.hasOverlayEntries).toBe(true);
				});

				uiFixture.terminal.sendInput("\x1b");
				await expect(overlayPromise).resolves.toBe("overlay-dismissed");
				await runPromise;
				await harness.session.waitForIdle();

				expect(harness.session.runtimeLifecycle.isCurrent(fenceBeforeWait)).toBe(true);
				expect(harness.faux.state.callCount).toBe(1);
				expect(scheduler.inspect().activeWaits).toBe(0);

				const sessionFile = coord.manager.getSessionFile();
				expect(sessionFile).toBeTruthy();
				const reopened = SessionManager.open(sessionFile!);
				const savedMessages = reopened
					.getEntries()
					.filter((e) => e.type === "message")
					.map((e) => e.message);
				const savedToolCall = savedMessages.find(
					(m) =>
						m.role === "assistant" &&
						m.content.some((c) => c.type === "toolCall" && c.name === "wait_under_dialog"),
				);
				const savedToolResult = savedMessages.find(
					(m) =>
						m.role === "toolResult" &&
						m.toolName === "wait_under_dialog" &&
						JSON.stringify(m.content).includes("outcome:interrupted"),
				);
				expect(savedToolCall).toBeDefined();
				expect(savedToolResult).toBeDefined();
			} finally {
				uiFixture.cleanup();
				coord.cleanup();
			}
		},
	);

	it.each(["regular", "fullscreen"] as const)(
		"Row 4 (%s): capturing overlay during live stream, stacked overlays, passive non-capturing overlay, and disconnected coordinator",
		async (tuiMode) => {
			const coord = await createCoordinationHarness();
			const { harness, coordinator, scheduler } = coord;
			scheduler.bind(coordinator);
			const cancelSpy = vi.spyOn(coordinator, "cancelPermissions");
			const uiFixture = createInteractiveCancelFixture(harness.session, tuiMode);

			try {
				// 4a. Capturing overlay while unrelated natural model stream is active:
				// Esc revokes grant and closes overlay while keeping natural stream alive and preserving its final text!
				const streamEntered = Promise.withResolvers<void>();
				const streamGate = Promise.withResolvers<void>();
				harness.setResponses([
					async () => {
						streamEntered.resolve();
						await streamGate.promise;
						return fauxAssistantMessage("UNINTERRUPTED_NATURAL_FINAL_TEXT");
					},
				]);

				const receiptOverlay = await scheduler.grant({ kind: "job", attemptId: "job-row4-overlay" });
				const fenceBefore = harness.session.runtimeLifecycle.capture();
				const runningStream = harness.session.prompt("natural user stream");
				await streamEntered.promise;

				uiFixture.mode.editor.setText("DRAFT_DURING_STREAM");
				let overlaySawRevoked = false;
				const overlay1 = uiFixture.mode.showExtensionCustom<string>(
					(_tui, _theme, _kb, done) => ({
						render: () => ["capturing-overlay"],
						invalidate: () => {},
						handleInput: (data: string) => {
							if (data === "\x1b") {
								overlaySawRevoked =
									scheduler.inspect().grants.find((g) => g.grantId === receiptOverlay.grantId)?.state ===
									"revoked";
								done("closed-overlay");
							}
						},
					}),
					{ overlay: true },
				);
				await vi.waitFor(() => {
					expect(uiFixture.mode.renderer.hasOverlayEntries).toBe(true);
				});

				// Press Esc to dismiss the overlay while the natural stream is running
				uiFixture.terminal.sendInput("\x1b");
				await expect(overlay1).resolves.toBe("closed-overlay");
				expect(overlaySawRevoked).toBe(true);
				expect(scheduler.inspect().permissionEpoch).toBe(1);
				expect(cancelSpy).toHaveBeenCalledTimes(1);

				// RuntimeFence is still current and natural stream finishes with its final text intact!
				expect(harness.session.runtimeLifecycle.isCurrent(fenceBefore)).toBe(true);
				streamGate.resolve();
				await runningStream;
				expect(harness.session.getLastAssistantText()).toBe("UNINTERRUPTED_NATURAL_FINAL_TEXT");
				expect(uiFixture.mode.editor.getText()).toBe("DRAFT_DURING_STREAM");

				// 4b. Stacked overlays
				seedDraftAndQueues(harness.session, uiFixture.mode.editor);
				const receiptStacked = await scheduler.grant({ kind: "job", attemptId: "job-row4-stacked" });
				const bottomOverlay = uiFixture.mode.showExtensionCustom<string>(
					(_tui, _theme, _kb, done) => ({
						render: () => ["bottom-overlay"],
						invalidate: () => {},
						handleInput: (data: string) => {
							if (data === "\x1b") done("bottom-closed");
						},
					}),
					{ overlay: true },
				);
				await vi.waitFor(() => {
					expect(uiFixture.mode.renderer.hasOverlayEntries).toBe(true);
				});
				let topOverlayComponent: Component | undefined;
				const topOverlay = uiFixture.mode.showExtensionCustom<string>(
					(_tui, _theme, _kb, done) => {
						topOverlayComponent = {
							render: () => ["top-overlay"],
							invalidate: () => {},
							handleInput: (data: string) => {
								if (data === "\x1b") done("top-closed");
							},
						};
						return topOverlayComponent;
					},
					{ overlay: true },
				);
				await vi.waitFor(() => {
					expect(topOverlayComponent).toBeDefined();
					expect(uiFixture.mode.renderer.getFocusedComponent()).toBe(topOverlayComponent);
				});

				uiFixture.terminal.sendInput("\x1b");
				await expect(topOverlay).resolves.toBe("top-closed");
				expect(scheduler.inspect().grants.find((g) => g.grantId === receiptStacked.grantId)?.state).toBe("revoked");
				expect(scheduler.inspect().permissionEpoch).toBe(2);
				expect(cancelSpy).toHaveBeenCalledTimes(2);

				uiFixture.terminal.sendInput("\x1b");
				await expect(bottomOverlay).resolves.toBe("bottom-closed");
				expect(scheduler.inspect().permissionEpoch).toBe(2);
				expect(cancelSpy).toHaveBeenCalledTimes(2);
				expectDraftAndQueuesPreserved(harness.session, uiFixture.mode.editor);

				// 4c. Non-capturing passive overlay with focus in editor (keep draft, no queues so editor onEscape doesn't dequeue)
				(
					harness.session as unknown as { _steeringMessages: string[]; _followUpMessages: string[] }
				)._steeringMessages.length = 0;
				(
					harness.session as unknown as { _steeringMessages: string[]; _followUpMessages: string[] }
				)._followUpMessages.length = 0;
				uiFixture.mode.editor.setText("PASSIVE_OVERLAY_DRAFT");

				const receiptPassive = await scheduler.grant({ kind: "job", attemptId: "job-row4-passive" });
				let closePassive: ((v: string) => void) | undefined;
				const passiveOverlay = uiFixture.mode.showExtensionCustom<string>(
					(_tui, _theme, _kb, done) => {
						closePassive = done;
						return {
							render: () => ["passive-overlay"],
							invalidate: () => {},
						};
					},
					{ overlay: true, overlayOptions: { nonCapturing: true } },
				);
				await vi.waitFor(() => {
					expect(uiFixture.mode.renderer.hasOverlayEntries).toBe(true);
				});
				expect(uiFixture.mode.renderer.getFocusedComponent()).toBe(uiFixture.mode.editor);

				uiFixture.terminal.sendInput("\x1b");
				expect(scheduler.inspect().grants.find((g) => g.grantId === receiptPassive.grantId)?.state).toBe("revoked");
				expect(scheduler.inspect().permissionEpoch).toBe(3);
				expect(cancelSpy).toHaveBeenCalledTimes(3);
				expect(uiFixture.mode.editor.getText()).toBe("PASSIVE_OVERLAY_DRAFT");
				closePassive?.("done");
				await passiveOverlay;

				// 4d. Disconnected coordinator: local revocation still happens before focused handler
				const receiptOffline = await scheduler.grant({ kind: "job", attemptId: "job-row4-offline" });
				cancelSpy.mockRejectedValueOnce(new Error("Coordinator offline"));
				let offlineFocusSawRevoked = false;
				const offlineOverlay = uiFixture.mode.showExtensionCustom<string>(
					(_tui, _theme, _kb, done) => ({
						render: () => ["offline-overlay"],
						invalidate: () => {},
						handleInput: (data: string) => {
							if (data === "\x1b") {
								offlineFocusSawRevoked =
									scheduler.inspect().grants.find((g) => g.grantId === receiptOffline.grantId)?.state ===
									"revoked";
								done("offline-closed");
							}
						},
					}),
					{ overlay: true },
				);
				await vi.waitFor(() => {
					expect(uiFixture.mode.renderer.hasOverlayEntries).toBe(true);
				});

				uiFixture.terminal.sendInput("\x1b");
				await expect(offlineOverlay).resolves.toBe("offline-closed");
				expect(offlineFocusSawRevoked).toBe(true);
				expect(scheduler.inspect().permissionEpoch).toBe(4);
			} finally {
				uiFixture.cleanup();
				coord.cleanup();
			}
		},
	);

	it("Row 5: consuming/rewriting onTerminalInput listener, renderer mode switch, and session replacement rebind", async () => {
		const coord1 = await createCoordinationHarness();
		const { harness: harness1, coordinator: coordinator1, scheduler: scheduler1 } = coord1;
		scheduler1.bind(coordinator1);
		const cancelSpy1 = vi.spyOn(coordinator1, "cancelPermissions");

		const uiFixture = createInteractiveCancelFixture(harness1.session, "regular");

		try {
			seedDraftAndQueues(harness1.session, uiFixture.mode.editor);

			// 5a. Consuming onTerminalInput listener
			const receiptConsume = await scheduler1.grant({ kind: "job", attemptId: "job-row5-consume" });
			let listenerSawRevoked = false;
			const unsubConsume = uiFixture.mode.addExtensionTerminalInputListener((data) => {
				if (data === "\x1b") {
					listenerSawRevoked =
						scheduler1.inspect().grants.find((g) => g.grantId === receiptConsume.grantId)?.state === "revoked";
					return { consume: true };
				}
				return undefined;
			});

			uiFixture.terminal.sendInput("\x1b");
			expect(listenerSawRevoked).toBe(true);
			expect(scheduler1.inspect().permissionEpoch).toBe(1);
			expect(cancelSpy1).toHaveBeenCalledTimes(1);
			expectDraftAndQueuesPreserved(harness1.session, uiFixture.mode.editor);
			unsubConsume();

			// 5b. Rewriting onTerminalInput listener + rebind/clear extension listeners does not remove observer
			const receiptRewrite = await scheduler1.grant({ kind: "job", attemptId: "job-row5-rewrite" });
			let rewrittenSawRevoked = false;
			uiFixture.mode.addExtensionTerminalInputListener((data) => {
				if (data === "\x1b") {
					rewrittenSawRevoked =
						scheduler1.inspect().grants.find((g) => g.grantId === receiptRewrite.grantId)?.state === "revoked";
					return { data: "x" };
				}
				return undefined;
			});
			uiFixture.mode.rebindExtensionTerminalInputListeners();

			uiFixture.terminal.sendInput("\x1b");
			expect(rewrittenSawRevoked).toBe(true);
			expect(scheduler1.inspect().permissionEpoch).toBe(2);
			expect(cancelSpy1).toHaveBeenCalledTimes(2);

			uiFixture.mode.clearExtensionTerminalInputListeners();

			// 5c. Renderer mode switch (regular -> fullscreen -> regular with startRenderer=false)
			const receiptFullscreen = await scheduler1.grant({ kind: "job", attemptId: "job-row5-fullscreen" });
			expect(uiFixture.mode.switchTuiMode("fullscreen", false, true)).toBe(true);
			expect(uiFixture.mode.renderer.mode).toBe("fullscreen");

			uiFixture.terminal.sendInput("\x1b");
			expect(scheduler1.inspect().grants.find((g) => g.grantId === receiptFullscreen.grantId)?.state).toBe(
				"revoked",
			);
			expect(scheduler1.inspect().permissionEpoch).toBe(3);
			expect(cancelSpy1).toHaveBeenCalledTimes(3);

			// Switch with startRenderer=false still binds the observer before returning
			const receiptUnstartedSwitch = await scheduler1.grant({ kind: "job", attemptId: "job-row5-switch-unstarted" });
			expect(uiFixture.mode.switchTuiMode("regular", false, false)).toBe(true);
			uiFixture.mode.renderer.start();

			uiFixture.terminal.sendInput("\x1b");
			expect(scheduler1.inspect().grants.find((g) => g.grantId === receiptUnstartedSwitch.grantId)?.state).toBe(
				"revoked",
			);
			expect(scheduler1.inspect().permissionEpoch).toBe(4);
			expect(cancelSpy1).toHaveBeenCalledTimes(4);

			// 5d. Session replacement: observer dynamically targets the new session's coordinationScheduler
			const coord2 = await createCoordinationHarness();
			try {
				const { harness: harness2, coordinator: coordinator2, scheduler: scheduler2 } = coord2;
				scheduler2.bind(coordinator2);
				const cancelSpy2 = vi.spyOn(coordinator2, "cancelPermissions");

				const receiptNewSession = await scheduler2.grant({ kind: "job", attemptId: "job-row5-new-session" });
				uiFixture.mode.runtimeHost.session = harness2.session;

				uiFixture.terminal.sendInput("\x1b");
				expect(scheduler2.inspect().grants.find((g) => g.grantId === receiptNewSession.grantId)?.state).toBe(
					"revoked",
				);
				expect(scheduler2.inspect().permissionEpoch).toBe(1);
				expect(cancelSpy2).toHaveBeenCalledTimes(1);
				// Old session's scheduler was not called again
				expect(scheduler1.inspect().permissionEpoch).toBe(4);
				expect(cancelSpy1).toHaveBeenCalledTimes(4);
			} finally {
				coord2.cleanup();
			}
		} finally {
			uiFixture.cleanup();
			coord1.cleanup();
		}
	});
});
