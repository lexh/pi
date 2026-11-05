import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionActions, ExtensionAPI, ExtensionContextActions } from "../src/core/extensions/types.ts";
import type { ModelRegistry } from "../src/core/model-registry.ts";
import { createUnavailableRuntimeLifecycle } from "../src/core/runtime-incarnation.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { coordinationExtensionActions } from "./helpers/extension-coordination-actions.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

describe("ExtensionRunner", () => {
	let tempDir: string;
	let sessionManager: SessionManager;
	let modelRegistry: ModelRegistry;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runner-test-"));
		sessionManager = SessionManager.inMemory();
		modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	const extensionActions: ExtensionActions = {
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		getSettings: () => ({}),
		setActiveTools: () => {},
		refreshTools: () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => "off",
		setThinkingLevel: () => {},
	};

	const extensionContextActions: ExtensionContextActions = {
		getModel: () => undefined,
		isIdle: () => true,
		isProjectTrusted: () => true,
		getSignal: () => undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		getScopedModels: () => [],
	};

	it("forwards a bound lifecycle getter only while the extension runtime is active", async () => {
		const runtime = createExtensionRuntime();
		let getter: ExtensionAPI["getRuntimeLifecycle"] | undefined;
		let loadingError: unknown;
		const extension = await loadExtensionFromFactory(
			(pi) => {
				getter = pi.getRuntimeLifecycle;
				try {
					getter();
				} catch (error) {
					loadingError = error;
				}
			},
			tempDir,
			createEventBus(),
			runtime,
		);
		expect(loadingError).toBeInstanceOf(Error);
		expect(String(loadingError)).toMatch(/not initialized/i);
		const facade = createUnavailableRuntimeLifecycle("fixture");
		const runner = new ExtensionRunner([extension], runtime, tempDir, sessionManager, modelRegistry);
		runner.bindCore(extensionActions, extensionContextActions);
		runner.bindCoordination({ ...coordinationExtensionActions, getRuntimeLifecycle: () => facade });
		expect(getter!()).toBe(facade);
		runner.invalidate("stale runtime");
		expect(() => getter!()).toThrow("stale runtime");
	});

	it("resolves admission facades dynamically from API and context", async () => {
		const runtime = createExtensionRuntime();
		let api: ExtensionAPI | undefined;
		const extension = await loadExtensionFromFactory(
			(pi) => {
				api = pi;
			},
			tempDir,
			createEventBus(),
			runtime,
		);
		const runner = new ExtensionRunner([extension], runtime, tempDir, sessionManager, modelRegistry);
		const first = coordinationExtensionActions.getRequestAdmission();
		const second = coordinationExtensionActions.getRequestAdmission();
		let current = first;
		runner.bindCore(extensionActions, extensionContextActions);
		runner.bindCoordination({ ...coordinationExtensionActions, getRequestAdmission: () => current });
		const context = runner.createContext();
		expect(api?.requestAdmission).toBe(first);
		expect(context.requestAdmission).toBe(first);
		current = second;
		expect(api?.requestAdmission).toBe(second);
		expect(context.requestAdmission).toBe(second);
		runner.invalidate("stale runtime");
		expect(() => api?.requestAdmission).toThrow("stale runtime");
		expect(() => context.requestAdmission).toThrow("stale runtime");
	});

	it("forwards external refresh only while the extension runtime is active", async () => {
		const runtime = createExtensionRuntime();
		let api: ExtensionAPI | undefined;
		const extension = await loadExtensionFromFactory(
			(pi) => {
				api = pi;
			},
			tempDir,
			createEventBus(),
			runtime,
		);
		const runner = new ExtensionRunner([extension], runtime, tempDir, sessionManager, modelRegistry);
		if (!api) throw new Error("Expected extension API");
		const refresh = api.refreshExternalEvents;
		expect(() => refresh()).toThrow(/not initialized/i);
		const action = vi.fn(() => true);
		runner.bindCore(extensionActions, extensionContextActions);
		runner.bindCoordination({ ...coordinationExtensionActions, refreshExternalEvents: action });
		const update = { sessionId: "session", revision: 1, verified: false as const };
		expect(refresh(update)).toBe(true);
		expect(action).toHaveBeenCalledWith(update);
		runner.invalidate("stale runtime");
		expect(() => refresh(update)).toThrow(/stale runtime/i);
		expect(action).toHaveBeenCalledTimes(1);
	});
});
