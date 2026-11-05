import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type AgentSessionRuntime,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import type { ExtensionAPI } from "../src/core/extensions/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { REPLACEMENT_BUSY_STATUS } from "../src/modes/interactive/interactive-coordination.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { attachCoordination } from "./helpers/interactive-coordination.ts";
import { userMsg } from "./utilities.ts";

type Mode = {
	handleClearCommand(): Promise<void>;
	handleResumeSession(path: string): Promise<{ cancelled: boolean }>;
	handleImportCommand(text: string): Promise<void>;
	handleCloneCommand(): Promise<void>;
	handleReloadCommand(): Promise<void>;
	setupEditorSubmitHandler(): void;
};

const COMMANDS = ["/new", "/reload", "/fork", "/clone", "/resume", "/import target.jsonl"];

/** A real runtime whose next replacement pauses in session_before_switch until released. */
async function pausedReplacementRuntime() {
	const directory = join(tmpdir(), `pi-interactive-replacement-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(directory, { recursive: true });
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let pause = true;
	const extension = (pi: ExtensionAPI) => {
		pi.on("session_before_switch", async () => {
			if (!pause) return;
			pause = false;
			entered.resolve();
			await release.promise;
		});
	};
	const sessionManager = SessionManager.create(directory, join(directory, "sessions"));
	sessionManager.appendMessage(userMsg("hello"));
	const runtime = await createAgentSessionRuntime(
		async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: directory,
				resourceLoaderOptions: {
					extensionFactories: [extension],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
			return { ...result, services, diagnostics: services.diagnostics };
		},
		{ cwd: directory, agentDir: directory, sessionManager },
	);
	const cleanup = async () => {
		release.resolve();
		await runtime.dispose();
		rmSync(directory, { recursive: true, force: true });
	};
	return { runtime, directory, entered: entered.promise, release: () => release.resolve(), cleanup };
}

function interactiveMode(runtime: Pick<AgentSessionRuntime, "session"> & Partial<AgentSessionRuntime>) {
	const mode = Object.create(InteractiveMode.prototype) as Mode & Record<string, any>;
	const children: unknown[] = [];
	Object.assign(mode, {
		runtimeHost: runtime,
		showStatus: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		clearStatusIndicator: vi.fn(),
		handleFatalRuntimeError: vi.fn(async () => {
			throw new Error("unexpected fatal runtime error");
		}),
		showExtensionConfirm: vi.fn(async () => true),
		resetExtensionUI: vi.fn(),
		editor: { setText: vi.fn() },
		defaultEditor: { onSubmit: undefined },
		editorContainer: {
			children,
			clear: () => children.splice(0),
			addChild: (child: unknown) => children.push(child),
		},
		ui: { setFocus: vi.fn(), requestRender: vi.fn(), addInputObserver: vi.fn() },
	});
	return mode;
}

describe("interactive runtime replacement containment", () => {
	afterEach(() => vi.restoreAllMocks());

	it("refuses replacement commands at submit while a replacement runs, keeping the editor", async () => {
		for (const busy of ["runtime", "session"] as const) {
			const runtimeHost = {
				isReplacementInProgress: busy === "runtime",
				session: { isReplacementInProgress: busy === "session" },
			};
			const mode = interactiveMode(runtimeHost as never);
			attachCoordination(mode);
			const handlers = [
				"handleClearCommand",
				"handleReloadCommand",
				"showUserMessageSelector",
				"handleCloneCommand",
				"showSessionSelector",
				"handleImportCommand",
			];
			for (const name of handlers) mode[name] = vi.fn();
			mode.setupEditorSubmitHandler();
			for (const command of COMMANDS) await mode.defaultEditor.onSubmit(command);
			for (const name of handlers) expect(mode[name]).not.toHaveBeenCalled();
			expect(mode.editor.setText).not.toHaveBeenCalled();
			expect(mode.showStatus).toHaveBeenCalledTimes(COMMANDS.length);
			expect(mode.showStatus).toHaveBeenCalledWith(REPLACEMENT_BUSY_STATUS);
		}
	});

	it("reports refusals from a real paused replacement as a status, without exiting", async () => {
		initTheme("dark", false);
		const f = await pausedReplacementRuntime();
		const exit = vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("unexpected exit");
		});
		try {
			const mode = interactiveMode(f.runtime);
			attachCoordination(mode).attach();
			const original = f.runtime.session;
			const replacing = f.runtime.newSession();
			await f.entered;
			const target = original.sessionFile!;
			await mode.handleClearCommand();
			expect(await mode.handleResumeSession(target)).toEqual({ cancelled: true });
			await mode.handleImportCommand(`/import ${target}`);
			await mode.handleCloneCommand();
			await mode.handleReloadCommand();
			expect(
				mode.showStatus.mock.calls.filter(([status]: [string]) => status === REPLACEMENT_BUSY_STATUS),
			).toHaveLength(4);
			expect(mode.showError).toHaveBeenCalledExactlyOnceWith(
				"Reload failed: Runtime replacement is already in progress",
			);
			expect(mode.editorContainer.children).toHaveLength(1);
			expect(mode.handleFatalRuntimeError).not.toHaveBeenCalled();
			expect(exit).not.toHaveBeenCalled();
			f.release();
			expect(await replacing).toEqual({ cancelled: false });
			expect(f.runtime.session).not.toBe(original);
		} finally {
			await f.cleanup();
		}
	});
});
