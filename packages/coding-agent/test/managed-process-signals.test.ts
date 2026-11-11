import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, expect, test, vi } from "vitest";
import { execCommand } from "../src/core/exec.ts";
import { launchManaged } from "../src/core/managed-process-launch.ts";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";
import type * as ShellModule from "../src/utils/shell.ts";
import { killProcessTree, untrackDetachedChildPid } from "../src/utils/shell.ts";

vi.mock("../src/core/managed-process-launch.ts", () => ({ launchManaged: vi.fn() }));
vi.mock("../src/utils/shell.ts", async (original) => {
	const shell = await original<typeof ShellModule>();
	return { ...shell, killProcessTree: vi.fn(), trackDetachedChildPid: vi.fn(), untrackDetachedChildPid: vi.fn() };
});

function childFixture() {
	const child = new ChildProcess();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	Object.defineProperty(child, "pid", { value: 42 });
	const kill = vi.spyOn(child, "kill").mockReturnValue(true);
	const launched = Promise.withResolvers<void>();
	let stopping = false;
	const launch = {
		child,
		registered: Promise.resolve(),
		cancelGate: vi.fn(),
		defersSignals: () => stopping,
		ended: vi.fn(),
	};
	vi.mocked(launchManaged).mockImplementation(() => {
		launched.resolve();
		return launch;
	});
	return {
		child,
		kill,
		launch,
		launched,
		stop: () => {
			stopping = true;
		},
		exit: () => {
			child.emit("exit", 0, null);
			child.emit("close", 0, null);
		},
	};
}
afterEach(() => {
	vi.useRealTimers();
	vi.clearAllMocks();
});

test("service cancellation closes the gate but sends no pi TERM or KILL", async () => {
	vi.useFakeTimers();
	const f = childFixture();
	const controller = new AbortController();
	const running = execCommand("unused", [], process.cwd(), { signal: controller.signal });
	try {
		await f.launched.promise;
		f.stop();
		controller.abort();
		await vi.advanceTimersByTimeAsync(5000);
		expect(f.launch.cancelGate).toHaveBeenCalled();
		expect(f.kill).not.toHaveBeenCalled();
		f.exit();
		expect((await running).killed).toBe(true);
	} finally {
		f.exit();
		await running;
	}
});

test("an already-scheduled local force-kill rechecks the service-stop latch", async () => {
	vi.useFakeTimers();
	const f = childFixture();
	const controller = new AbortController();
	const running = execCommand("unused", [], process.cwd(), { signal: controller.signal });
	try {
		await f.launched.promise;
		controller.abort();
		expect(f.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
		f.stop();
		await vi.advanceTimersByTimeAsync(5000);
		expect(f.kill).toHaveBeenCalledTimes(1);
		f.exit();
		await running;
	} finally {
		f.exit();
		await running;
	}
});

test("ordinary Escape retains local TERM and bounded KILL behavior", async () => {
	vi.useFakeTimers();
	const f = childFixture();
	const controller = new AbortController();
	const running = execCommand("unused", [], process.cwd(), { signal: controller.signal });
	try {
		await f.launched.promise;
		controller.abort();
		await vi.advanceTimersByTimeAsync(5000);
		expect(f.kill.mock.calls.map((call) => call[0])).toEqual(["SIGTERM", "SIGKILL"]);
		f.exit();
		await running;
	} finally {
		f.exit();
		await running;
	}
});

for (const stopping of [false, true]) {
	test(`bash abort defers process-tree signal only for service stop=${stopping}`, async () => {
		const f = childFixture();
		const controller = new AbortController();
		const running = createLocalBashOperations().exec("unused", process.cwd(), {
			signal: controller.signal,
			onData: () => {},
		});
		void running.catch(() => {});
		try {
			await f.launched.promise;
			if (stopping) f.stop();
			controller.abort();
			expect(f.launch.cancelGate).toHaveBeenCalled();
			expect(vi.mocked(killProcessTree).mock.calls.length).toBe(stopping ? 0 : 1);
			if (stopping) expect(untrackDetachedChildPid).toHaveBeenCalledWith(42);
			f.exit();
			await expect(running).rejects.toThrow(/aborted/);
		} finally {
			f.exit();
			await running.catch(() => {});
		}
	});
}
