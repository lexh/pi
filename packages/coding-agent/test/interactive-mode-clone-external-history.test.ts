import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { readExternalEntry } from "../src/core/external-event-records.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import {
	ADMITTED_BODY,
	admission,
	canonical,
	PENDING_BODY,
	savedFixture,
	selectSyntheticAdmission,
} from "./helpers/external-events.ts";
import { FakeRuntimeCoordinator } from "./helpers/fake-runtime-coordinator.ts";
import { userMsg } from "./utilities.ts";

type CloneCommandContext = {
	sessionManager: { getLeafId: () => string | null };
	runtimeHost: {
		fork: (entryId: string, options?: { position?: "before" | "at" }) => Promise<{ cancelled: boolean }>;
	};
	renderCurrentSessionState: () => void;
	editor: { setText: (text: string) => void };
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	ui: { requestRender: () => void };
};

type InteractiveModePrototype = {
	handleCloneCommand(this: CloneCommandContext): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("InteractiveMode /clone", () => {
	it("clones external history through the real runtime host without starting an agent", async () => {
		const f = savedFixture();
		const pending = f.manager.appendEntryOnce(canonical("pending"), f.selected).entryId;
		f.manager.branch(pending);
		const anchor = f.manager.appendMessage(userMsg("anchor"));
		const admitted = selectSyntheticAdmission(f.manager, admission(canonical("admitted", "other"), anchor));
		f.manager.appendMessage(userMsg("leaf"));
		const source = f.manager.getSessionFile()!;
		const sourceId = f.manager.getSessionId();
		const starts: string[] = [];
		const streams: string[] = [];
		const runtime = await createAgentSessionRuntime(
			async ({ cwd, sessionManager, sessionStartEvent }) => {
				const services = await createAgentSessionServices({
					cwd,
					agentDir: f.directory,
					resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true },
				});
				const result = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
				result.session.subscribe((event) => {
					if (event.type === "agent_start") starts.push(result.session.sessionId);
				});
				const stream = result.session.agent.streamFunction;
				result.session.agent.streamFunction = (...args) => {
					streams.push(result.session.sessionId);
					return stream(...args);
				};
				return {
					...result,
					services,
					diagnostics: services.diagnostics,
				};
			},
			{ cwd: f.directory, agentDir: f.directory, sessionManager: f.manager },
		);
		try {
			const leaf = f.manager.getLeafId();
			const before = readFileSync(source);
			const fake = new FakeRuntimeCoordinator();
			const scope = runtime.session.runtimeLifecycle;
			scope.participate();
			await scope.reconcile(fake.exchange);
			const fence = scope.capture();
			fake.seedOwnedWork(fence.mailboxId, "clone-owned");
			const revoked: string[] = [];
			for (const kind of ["wait", "grant", "claim"] as const)
				scope.track(fence, { kind, id: kind, revoke: () => revoked.push(kind) });
			const status = vi.fn();
			const error = vi.fn();
			const context: CloneCommandContext = {
				sessionManager: f.manager,
				runtimeHost: runtime,
				renderCurrentSessionState: vi.fn(),
				editor: { setText: vi.fn() },
				showStatus: status,
				showError: error,
				ui: { requestRender: vi.fn() },
			};
			await interactiveModePrototype.handleCloneCommand.call(context);
			expect(error).not.toHaveBeenCalled();
			expect(status).toHaveBeenCalledWith("Cloned to new session");
			runtime.session.runtimeLifecycle.participate();
			await runtime.session.runtimeLifecycle.reconcile(fake.exchange);
			const fresh = runtime.session.runtimeLifecycle.capture();
			expect(fresh.mailboxId).not.toBe(fence.mailboxId);
			expect(fresh.instanceId).not.toBe(fence.instanceId);
			expect(fresh.hostId).toBe(fence.hostId);
			expect(fresh.incarnation).toBeGreaterThan(fence.incarnation);
			expect(fake.ownerOf("clone-owned")).toBe(fence.mailboxId);
			expect(scope.isCurrent(fence)).toBe(false);
			expect(revoked).toEqual(["wait", "grant", "claim"]);
			const destination = SessionManager.open(runtime.session.sessionFile!);
			expect(destination.getLeafId()).toBe(leaf);
			expect(readFileSync(destination.getSessionFile()!, "utf8")).not.toContain(PENDING_BODY);
			expect(JSON.stringify(destination.buildSessionContext().messages)).toContain(ADMITTED_BODY);
			expect(
				destination
					.getEntries()
					.map(readExternalEntry)
					.find((entry) => entry?.kind === "inherited"),
			).toMatchObject({
				origin: { sessionId: sourceId, entryId: admitted },
				copiedFrom: { sessionId: sourceId, entryId: admitted },
			});
			expect(readFileSync(source)).toEqual(before);
			expect(starts).toEqual([]);
			expect(streams).toEqual([]);
		} finally {
			await runtime.dispose();
			f.cleanup();
		}
	});
});
