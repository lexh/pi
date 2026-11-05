import { Container } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import type { UserMessageSelectorComponent } from "../src/modes/interactive/components/user-message-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { admission, canonical, savedFixture } from "./helpers/external-events.ts";
import { createHarness } from "./suite/harness.ts";

describe("reserved tree navigation", () => {
	beforeEach(() => initTheme("dark"));
	it.each(["", "draft that must survive"])(
		"does not prefill the editor when selecting external entries with draft %j",
		async (draft) => {
			const fixture = savedFixture();
			const event = canonical();
			const canonicalId = fixture.manager.appendEntryOnce(event, fixture.root).entryId;
			const admissionId = fixture.manager.appendEntryOnce(
				admission(event, fixture.selected),
				fixture.selected,
			).entryId;
			const harness = await createHarness({ sessionManager: fixture.manager });
			harness.settingsManager.setTreeFilterMode("all");
			let selector: TreeSelectorComponent | undefined;
			let text = draft;
			const setText = vi.fn((value: string) => {
				text = value;
			});
			const context = {
				sessionManager: fixture.manager,
				settingsManager: harness.settingsManager,
				session: harness.session,
				defaultEditor: { onEscape: undefined as (() => void) | undefined, onAction: vi.fn() },
				editor: { getText: () => text, setText },
				chatContainer: new Container(),
				ui: { terminal: { rows: 24 }, requestRender: vi.fn() },
				showSelector: (create: (done: () => void) => { component: TreeSelectorComponent }) => {
					selector = create(vi.fn()).component;
				},
				showExtensionSelector: vi.fn(async () => "No summary"),
				showStatus: vi.fn(),
				showError: vi.fn(),
				renderInitialMessages: vi.fn(),
				flushCompactionQueue: vi.fn(async () => {}),
			};
			const showTree = Reflect.get(InteractiveMode.prototype, "showTreeSelector") as (
				this: typeof context,
				initialSelectedId?: string,
			) => void;
			try {
				if (draft === "") {
					harness.settingsManager.setDoubleEscapeAction("tree");
					const dispatch = Object.assign(context, {
						isBashMode: false,
						lastEscapeTime: 0,
						showTreeSelector: () => showTree.call(context),
					});
					const setup = Reflect.get(InteractiveMode.prototype, "setupKeyHandlers") as (
						this: typeof dispatch,
					) => void;
					setup.call(dispatch);
					for (const [id, body] of [
						[canonicalId, "UNREAD_BODY_7d81"],
						[admissionId, "ADMITTED_BODY_c9f2"],
					] as const) {
						fixture.manager.branch(fixture.selected);
						vi.useFakeTimers();
						vi.setSystemTime(1000);
						dispatch.defaultEditor.onEscape?.();
						vi.advanceTimersByTime(100);
						dispatch.defaultEditor.onEscape?.();
						vi.useRealTimers();
						expect(selector).toBeDefined();
						selector!.handleInput(body);
						expect(selector!.getTreeList().getSelectedNode()?.entry.id).toBe(id);
						await selector!.getTreeList().onSelect!(id);
						expect(setText).not.toHaveBeenCalled();
					}
				}
				for (const id of [canonicalId, admissionId]) {
					fixture.manager.branch(fixture.selected);
					showTree.call(context, id);
					expect(selector).toBeDefined();
					expect(selector!.getTreeList().getSelectedNode()?.entry.id).toBe(id);
					await selector!.getTreeList().onSelect!(id);
					expect(text).toBe(draft);
					expect(setText).not.toHaveBeenCalled();
					expect(fixture.manager.getLeafId()).toBe(id);
				}
				expect(harness.faux.state.callCount).toBe(0);
			} finally {
				vi.useRealTimers();
				harness.cleanup();
				fixture.cleanup();
			}
		},
	);
});

describe("double Escape fork selector", () => {
	it("opens only ordinary user messages", async () => {
		initTheme("dark");
		const fixture = savedFixture();
		const event = canonical();
		fixture.manager.appendEntryOnce(event, fixture.root);
		fixture.manager.appendEntryOnce(admission(event, fixture.selected), fixture.selected);
		const harness = await createHarness({ sessionManager: fixture.manager });
		harness.settingsManager.setDoubleEscapeAction("fork");
		let selector: UserMessageSelectorComponent | undefined;
		const context = {
			runtimeHost: { session: harness.session },
			session: harness.session,
			settingsManager: harness.settingsManager,
			defaultEditor: { onEscape: undefined as (() => void) | undefined, onAction: vi.fn() },
			editor: { getText: () => "" },
			isBashMode: false,
			lastEscapeTime: 0,
			ui: { onDebug: undefined },
			showSelector: (create: (done: () => void) => { component: UserMessageSelectorComponent }) => {
				selector = create(vi.fn()).component;
			},
		};
		const showFork = Reflect.get(InteractiveMode.prototype, "showUserMessageSelector") as (
			this: typeof context,
		) => void;
		const dispatch = Object.assign(context, { showUserMessageSelector: () => showFork.call(context) });
		const setup = Reflect.get(InteractiveMode.prototype, "setupKeyHandlers") as (this: typeof dispatch) => void;
		try {
			setup.call(dispatch);
			vi.useFakeTimers();
			vi.setSystemTime(1000);
			dispatch.defaultEditor.onEscape?.();
			vi.advanceTimersByTime(100);
			dispatch.defaultEditor.onEscape?.();
			const output = selector?.getMessageList().render(100).join("\n") ?? "";
			expect(output).toContain("ordinary root");
			expect(output).not.toContain("UNREAD_BODY_7d81");
			expect(output).not.toContain("ADMITTED_BODY_c9f2");
			expect(harness.session.getUserMessagesForForking()).toHaveLength(1);
		} finally {
			vi.useRealTimers();
			harness.cleanup();
			fixture.cleanup();
		}
	});
});
