import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

describe("double Escape dispatch", () => {
	it.each(["tree", "fork", "none"] as const)("dispatches %s only with an empty editor", (action) => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(1000);
			let text = "";
			const defaultEditor: {
				onEscape?: () => void;
				onAction: ReturnType<typeof vi.fn>;
				onCtrlD?: () => void;
				onChange?: (text: string) => void;
				onPasteImage?: () => void;
			} = { onAction: vi.fn() };
			const context = {
				defaultEditor,
				editor: {
					getText: () => text,
					setText: (next: string) => {
						text = next;
					},
				},
				session: { isStreaming: false, isBashRunning: false },
				settingsManager: { getDoubleEscapeAction: () => action },
				isBashMode: false,
				lastEscapeTime: 0,
				ui: { onDebug: undefined },
				showTreeSelector: vi.fn(),
				showUserMessageSelector: vi.fn(),
			};
			const setup = Reflect.get(InteractiveMode.prototype, "setupKeyHandlers") as (this: typeof context) => void;
			setup.call(context);
			defaultEditor.onEscape?.();
			vi.advanceTimersByTime(100);
			defaultEditor.onEscape?.();
			expect(context.showTreeSelector).toHaveBeenCalledTimes(action === "tree" ? 1 : 0);
			expect(context.showUserMessageSelector).toHaveBeenCalledTimes(action === "fork" ? 1 : 0);
			text = "draft that must survive";
			defaultEditor.onEscape?.();
			vi.advanceTimersByTime(100);
			defaultEditor.onEscape?.();
			expect(text).toBe("draft that must survive");
			expect(context.showTreeSelector).toHaveBeenCalledTimes(action === "tree" ? 1 : 0);
			expect(context.showUserMessageSelector).toHaveBeenCalledTimes(action === "fork" ? 1 : 0);
		} finally {
			vi.useRealTimers();
		}
	});
});
