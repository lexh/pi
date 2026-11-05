import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { savedFixture } from "./helpers/external-events.ts";
import { attachCoordination } from "./helpers/interactive-coordination.ts";

it("shows a non-transcript notice for a suppressed request", async () => {
	const saved = savedFixture();
	try {
		initTheme("dark", false);
		const children: Array<{ render(width: number): string[] }> = [];
		const render = vi.fn();
		const editor = { text: "unsent text", setText: vi.fn() };
		const mode = Object.create(InteractiveMode.prototype) as {
			handleEvent(event: AgentSessionEvent): Promise<void>;
		};
		Object.assign(mode, {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			programStatus: { handleEvent: vi.fn() },
			chatContainer: { addChild: (child: { render(width: number): string[] }) => children.push(child) },
			ui: { requestRender: render },
			outputPad: 0,
			editor,
		});
		attachCoordination(mode);
		const leaf = saved.manager.getLeafId();
		const entries = saved.manager.getEntries();
		const projection = saved.manager.buildSessionProjection().messages;
		const bytes = readFileSync(saved.manager.getSessionFile()!);
		const event: AgentSessionEvent = {
			type: "request_suppressed",
			reason: "coordination-stale",
			errorMessage: "Request is stale",
		};
		await mode.handleEvent(event);
		expect(children).toHaveLength(2);
		expect(children.flatMap((child) => child.render(120)).join("\n")).toContain(
			"Error: Request suppressed: Request is stale",
		);
		expect(render).toHaveBeenCalledTimes(1);
		expect(editor.text).toBe("unsent text");
		expect(editor.setText).not.toHaveBeenCalled();
		expect(saved.manager.getLeafId()).toBe(leaf);
		expect(saved.manager.getEntries()).toEqual(entries);
		expect(saved.manager.buildSessionProjection().messages).toEqual(projection);
		expect(readFileSync(saved.manager.getSessionFile()!)).toEqual(bytes);
	} finally {
		saved.cleanup();
	}
});
