import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import * as hostModule from "../src/core/runtime-host.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { savedFixture } from "./helpers/external-events.ts";
import { createHarness } from "./suite/harness.ts";
import { userMsg } from "./utilities.ts";

describe("session runtime scope", () => {
	it("keeps normal prompting available when host acquisition fails", async () => {
		const spy = vi.spyOn(hostModule, "getProcessRuntimeHost").mockImplementation(() => {
			throw new Error("host unavailable");
		});
		try {
			const h = await createHarness();
			try {
				expect(h.session.runtimeLifecycle.inspect()).toEqual({ state: "unavailable", reason: "host unavailable" });
				h.setResponses([fauxAssistantMessage("ok")]);
				await h.session.prompt("hello");
				expect(h.faux.state.callCount).toBe(1);
			} finally {
				h.cleanup();
			}
		} finally {
			spy.mockRestore();
		}
	});
	it("persists an empty saved conversation only on participation", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-runtime-session-"));
		const manager = SessionManager.create(dir, dir);
		const h = await createHarness({ sessionManager: manager });
		try {
			const file = manager.getSessionFile()!;
			expect(existsSync(file)).toBe(false);
			expect(h.session.runtimeLifecycle).toBe(h.session.runtimeLifecycle);
			h.session.runtimeLifecycle.participate();
			expect(existsSync(file)).toBe(true);
			manager.appendMessage(userMsg("durable message"));
			expect(
				SessionManager.open(file)
					.getEntries()
					.some((entry) => entry.type === "message" && entry.message.role === "user"),
			).toBe(true);
		} finally {
			h.cleanup();
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("retires on dispose without changing transcript or selection and rejects later entry points", async () => {
		const f = savedFixture();
		const h = await createHarness({ sessionManager: f.manager });
		try {
			const lifecycle = h.session.runtimeLifecycle;
			lifecycle.participate();
			const inspection = lifecycle.inspect();
			if (inspection.state === "unavailable") throw new Error("Expected available scope");
			const host = hostModule.getProcessRuntimeHost();
			expect(host.getDesiredImage().runtimes.some((runtime) => runtime.instanceId === inspection.instanceId)).toBe(
				true,
			);
			const before = readFileSync(f.manager.getSessionFile()!, "utf8");
			const leaf = f.manager.getLeafId();
			lifecycle.cancel();
			h.session.dispose();
			h.session.dispose();
			expect(lifecycle.inspect().state).toBe("retired");
			expect(host.getDesiredImage().runtimes.some((runtime) => runtime.instanceId === inspection.instanceId)).toBe(
				false,
			);
			expect(before).not.toMatch(/credential|generationToken/);
			expect(readFileSync(f.manager.getSessionFile()!, "utf8")).toBe(before);
			expect(f.manager.getLeafId()).toBe(leaf);
			await expect(h.session.prompt("x")).rejects.toThrow(/disposed/);
			await expect(h.session.sendUserMessage("x")).rejects.toThrow(/disposed/);
			await expect(
				h.session.sendCustomMessage({ customType: "x", content: "x", display: false, details: undefined }),
			).rejects.toThrow(/disposed/);
			await expect(h.session.reload()).rejects.toThrow(/disposed/);
			expect(h.faux.state.callCount).toBe(0);
			expect(h.eventsOfType("agent_start")).toHaveLength(0);
		} finally {
			h.cleanup();
			f.cleanup();
		}
	});
	it("finishes disposal when retiring an exhausted host fails", async () => {
		const f = savedFixture();
		const host = new hostModule.RuntimeHost({ initialCounters: { revision: Number.MAX_SAFE_INTEGER - 1 } });
		const spy = vi.spyOn(hostModule, "getProcessRuntimeHost").mockReturnValue(host);
		try {
			const h = await createHarness({ sessionManager: f.manager });
			try {
				h.session.runtimeLifecycle.participate();
				expect(() => h.session.dispose()).not.toThrow();
				expect(h.session.isDisposed).toBe(true);
				await expect(h.session.prompt("x")).rejects.toThrow(/disposed/);
			} finally {
				h.cleanup();
			}
		} finally {
			spy.mockRestore();
			f.cleanup();
		}
	});
	it("refuses in-memory participation without preventing prompting", async () => {
		const h = await createHarness();
		try {
			expect(() => h.session.runtimeLifecycle.participate()).toThrow(/--no-session/);
			h.setResponses([fauxAssistantMessage("ok")]);
			await h.session.prompt("hello");
			expect(h.faux.state.callCount).toBe(1);
		} finally {
			h.cleanup();
		}
	});
	it("retires when the raw manager changes identity", async () => {
		const f = savedFixture();
		const h = await createHarness({ sessionManager: f.manager });
		try {
			const lifecycle = h.session.runtimeLifecycle;
			lifecycle.participate();
			f.manager.newSession();
			expect(() => lifecycle.participate()).toThrow(/changed/);
			expect(lifecycle.inspect().state).toBe("retired");
		} finally {
			h.cleanup();
			f.cleanup();
		}
	});
});
