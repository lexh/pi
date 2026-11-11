import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { expect, test } from "vitest";
import { execCommand } from "../src/core/exec.ts";
import type { ExtensionAPI, ToolDefinition } from "../src/core/extensions/types.ts";
import { type ManagedCallContext, withManagedCall } from "../src/core/managed-process-context.ts";
import { launchManaged } from "../src/core/managed-process-launch.ts";
import { ManagedProcessOwner } from "../src/core/managed-process-owner.ts";
import type { ProcessGap } from "../src/core/managed-process-types.ts";
import { getProcessRuntimeHost } from "../src/core/runtime-host.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createLocalBashOperations } from "../src/core/tools/bash.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";
import { FakeRuntimeCoordinator } from "./helpers/fake-runtime-coordinator.ts";
import { deferred, fixture } from "./helpers/managed-process.ts";
import { createHarness } from "./suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

async function attached(extension?: (pi: ExtensionAPI) => void, overrides: Parameters<typeof fixture>[0] = {}) {
	const directory = mkdtempSync(join(tmpdir(), "pi-managed-sites-"));
	const manager = SessionManager.create(directory, join(directory, "sessions"));
	manager.persistNow();
	const f = fixture(overrides);
	// The default test loader keeps its extensions on reload; this one runs the factory again, as a real reload does.
	const load = () => createTestExtensionsResult(extension ? [extension] : [], directory);
	let extensions = await load();
	const resourceLoader = {
		...createTestResourceLoader(),
		getExtensions: () => extensions,
		reload: async () => {
			extensions = await load();
		},
	};
	const harness = await createHarness({
		sessionManager: manager,
		settings: { cacheWarming: "off", compaction: { enabled: false } },
		initialActiveToolNames: ["bash"],
		resourceLoader,
	});
	await harness.session.bindExtensions({});
	harness.session.runtimeLifecycle.participate();
	await harness.session.runtimeLifecycle.reconcile(new FakeRuntimeCoordinator().exchange);
	harness.session.managedProcesses.bind(f.adapter);
	return {
		f,
		harness,
		close: () => {
			harness.cleanup();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

for (const audited of [false, true]) {
	test(`unaudited event/command boundaries leave coverage debt, audited=${audited}`, async () => {
		const gaps: ProcessGap[] = [];
		const f = await attached(
			(pi) => {
				if (audited) pi.declareProcessCoverage("no-spawn");
				pi.on("agent_start", () => {});
				pi.registerCommand("process-fixture", { description: "no side effects", handler: async () => {} });
			},
			{
				coverage: async (gap) => {
					gaps.push(gap);
				},
			},
		);
		try {
			f.harness.setResponses([fauxAssistantMessage("no processes")]);
			await f.harness.session.prompt("one run");
			expect(f.f.opened).toHaveLength(1);
			expect(
				gaps.some((gap) => gap.attemptId === f.f.opened[0].attemptId && gap.reason === "unsupported-tool"),
			).toBe(!audited);
		} finally {
			f.close();
		}
	});
}

test.skipIf(process.platform !== "darwin")(
	"actual built-in batch shares one attempt and preserves sibling tool IDs",
	async () => {
		const f = await attached();
		try {
			f.harness.setResponses([
				fauxAssistantMessage(
					[fauxToolCall("bash", { command: "printf first" }), fauxToolCall("bash", { command: "printf second" })],
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage("done"),
				fauxAssistantMessage("next independent run"),
			]);
			await f.harness.session.prompt("two commands");
			expect(f.f.opened).toHaveLength(1);
			expect(f.f.intents).toHaveLength(2);
			expect(new Set(f.f.intents.map((i) => i.attemptId)).size).toBe(1);
			expect(new Set(f.f.intents.map((i) => i.toolCallId)).size).toBe(2);
			expect(f.f.intents.every((i) => i.source === "bash")).toBe(true);
			await f.harness.session.prompt("another run without processes");
			expect(f.f.opened).toHaveLength(2);
			expect(f.f.opened[0].attemptId).not.toBe(f.f.opened[1].attemptId);
			expect(f.f.opened.every((a) => a.runId !== null)).toBe(true);
			expect(f.f.opened[0].runId).not.toBe(f.f.opened[1].runId);
		} finally {
			f.close();
		}
	},
);

test.skipIf(process.platform !== "darwin")(
	"standalone user bash, extension exec and managed spawn do not share attempts",
	async () => {
		let pi!: ExtensionAPI;
		const f = await attached((api) => {
			pi = api;
		});
		try {
			await f.harness.session.executeBash("printf user", undefined, { id: "user-one" });
			await f.harness.session.executeBash("printf again", undefined, { id: "user-two" });
			await pi.exec("/bin/echo", ["extension"]);
			const child = await pi.managedSpawn("/bin/true", []);
			await child.exited;
			expect(f.f.opened).toHaveLength(4);
			expect(new Set(f.f.opened.map((a) => a.attemptId)).size).toBe(4);
			expect(f.f.opened.every((a) => a.runId === null)).toBe(true);
			expect(f.f.intents.map((i) => i.source)).toEqual(["user-bash", "user-bash", "pi-exec", "extension"]);
			expect(f.f.intents.slice(0, 2).map((i) => i.toolCallId)).toEqual(["user-one", "user-two"]);
		} finally {
			f.close();
		}
	},
);

test.skipIf(process.platform !== "darwin")(
	"nested extension spawns retain the enclosing tool call and attempt",
	async () => {
		const f = await attached((pi) =>
			pi.registerTool({
				name: "nested",
				label: "nested",
				description: "managed fixture",
				processCoverage: "managed",
				parameters: Type.Object({}),
				execute: async () => {
					await pi.exec("/bin/true", []);
					const child = await pi.managedSpawn("/bin/true", []);
					await child.exited;
					return { content: [{ type: "text", text: "done" }], details: {} };
				},
			}),
		);
		try {
			f.harness.session.setActiveToolsByName(["nested"]);
			f.harness.setResponses([
				fauxAssistantMessage(fauxToolCall("nested", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await f.harness.session.prompt("nested");
			expect(f.f.opened).toHaveLength(1);
			expect(f.f.intents).toHaveLength(2);
			expect(f.f.intents[0].attemptId).toBe(f.f.intents[1].attemptId);
			expect(f.f.intents[0].toolCallId).toBe(f.f.intents[1].toolCallId);
		} finally {
			f.close();
		}
	},
);

test.skipIf(process.platform !== "darwin")(
	"delayed ACK and service stop close the gate without a pi OS signal",
	async () => {
		const ack = deferred<void>();
		const reached = deferred<void>();
		const f = fixture({
			register: async (intent) => {
				reached.resolve();
				await ack.promise;
				return {
					spawnId: intent.spawnId,
					watchId: "w",
					revision: 1,
					root: { pid: intent.pid, pgid: intent.pid, sid: intent.pid, birth: "kinfo:1", uniqueId: null },
				};
			},
		});
		const context = f.begin("gated");
		let output = "";
		const launch = withManagedCall(context, () =>
			launchManaged("/bin/echo", ["wrong"], { stdio: ["ignore", "pipe", "pipe"] }),
		);
		launch.child.stdout!.on("data", (chunk) => {
			output += chunk;
		});
		const exit = new Promise<void>((resolve) => launch.child.once("exit", () => resolve()));
		try {
			await reached.promise;
			expect(output).toBe("");
			const stop = f.registry.requestStop("gated", "stop-one", async () => {});
			expect(stop.requested).toBe(true);
			expect(launch.defersSignals()).toBe(true);
			ack.resolve();
			await launch.registered;
			await exit;
			expect(output).toBe("");
			expect(launch.child.exitCode).toBe(125);
			await stop.settled;
		} finally {
			ack.resolve();
			launch.cancelGate();
			launch.child.kill("SIGKILL");
			launch.ended(true);
		}
	},
);

for (const source of ["bash", "user-bash", "pi-exec", "managed-spawn"] as const) {
	for (const abort of [false, true]) {
		test.skipIf(process.platform !== "darwin")(`actual ${source}: delayed ACK with abort=${abort}`, async () => {
			const reached = deferred<void>();
			const release = deferred<void>();
			let pi!: ExtensionAPI;
			const f = await attached(
				(api) => {
					pi = api;
				},
				{
					register: async (intent) => {
						reached.resolve();
						await release.promise;
						return {
							spawnId: intent.spawnId,
							watchId: "delayed",
							revision: 1,
							root: { pid: intent.pid, pgid: intent.pid, sid: intent.pid, birth: "kinfo:1", uniqueId: null },
						};
					},
				},
			);
			const marker = join(f.harness.tempDir, "released-marker");
			const command = `printf launched > '${marker}'`;
			f.harness.setResponses([
				fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			const run =
				source === "bash"
					? f.harness.session.prompt("run")
					: source === "user-bash"
						? f.harness.session.executeBash(command, undefined, { id: "exact-user" })
						: source === "pi-exec"
							? pi.exec("/bin/sh", ["-c", 'printf launched > "$1"', "sh", marker])
							: pi
									.managedSpawn("/bin/sh", ["-c", 'printf launched > "$1"', "sh", marker])
									.then((child) => child.exited);
			void run.catch(() => {});
			try {
				await reached.promise;
				expect(existsSync(marker)).toBe(false);
				let settled: Promise<void> | undefined;
				if (abort) {
					const ack = f.harness.session.managedProcesses.requestStop(f.f.opened[0].attemptId, "target-stop");
					expect(ack.requested).toBe(true);
					settled = ack.settled;
				}
				release.resolve();
				await run.catch(() => {});
				await settled;
				expect(existsSync(marker)).toBe(!abort);
			} finally {
				release.resolve();
				await run.catch(() => {});
				f.close();
			}
		});
	}
}

test.skipIf(process.platform !== "darwin")(
	"bound exec missing target and genuine 127 both return nonzero actual gate results",
	async () => {
		const f = fixture();
		const context = f.begin("exec-failures");
		const missing = await withManagedCall(context, () =>
			execCommand("/definitely/missing/pi-managed-target", [], process.cwd()),
		);
		// The gate shell reports exec of a missing path (one that contains a slash) as 126; a missing bare command name is 127.
		expect(missing.code).toBe(126);
		expect(missing.stderr).toContain("/definitely/missing/pi-managed-target");
		const target127 = await withManagedCall(context, () => execCommand("/bin/sh", ["-c", "exit 127"], process.cwd()));
		expect(target127.code).toBe(127);
	},
);

test("unbound missing exec keeps ordinary Node ENOENT result byte-for-byte", async () => {
	const result = await execCommand("/definitely/missing/pi-managed-target", [], process.cwd());
	expect(result.code).toBe(1);
	expect(result.stderr).toBe("spawn /definitely/missing/pi-managed-target ENOENT");
	expect(result.stdout).toBe("");
	expect(result.killed).toBe(false);
});

test("already aborted local bash starts no process", async () => {
	const controller = new AbortController();
	controller.abort();
	await expect(
		createLocalBashOperations().exec("exit 0", process.cwd(), { signal: controller.signal, onData: () => {} }),
	).rejects.toThrow(/aborted/);
});

test.skipIf(process.platform !== "darwin")("outage releases ordinary bash and exec with retained gaps", async () => {
	const f = fixture({
		open: async () => {
			throw new Error("offline");
		},
	});
	const context = f.begin("offline");
	const shell = await withManagedCall(context, () =>
		createLocalBashOperations().exec("printf shell", process.cwd(), { onData: () => {} }),
	);
	const result = await withManagedCall(context, () => execCommand("/bin/echo", ["exec"], process.cwd()));
	expect(shell.exitCode).toBe(0);
	expect(result.stdout.trim()).toBe("exec");
	expect(f.registry.inspect().gaps).toContain("registration-outage");
	expect(f.registry.snapshot().entries).toHaveLength(2);
});

test.skipIf(process.platform !== "darwin")(
	"service stop retains child cancellation after managed handle delivery",
	async () => {
		let pi!: ExtensionAPI;
		const f = await attached((api) => {
			pi = api;
		});
		let child: Awaited<ReturnType<ExtensionAPI["managedSpawn"]>> | undefined;
		try {
			child = await pi.managedSpawn("/bin/sleep", ["60"]);
			const intent = f.f.intents[0];
			const ack = pi.managedProcesses.requestStop(intent.attemptId, "after-handle");
			expect(ack.requested).toBe(true);
			let settled = false;
			void ack.settled.then(() => {
				settled = true;
			});
			await Promise.resolve();
			expect(settled).toBe(false);
			expect(child.child.killed).toBe(false);
			// Fake adapter unit only: simulate the separate service sending TERM after its ACK.
			child.child.kill("SIGTERM");
			await child.exited;
			await ack.settled;
			const entry = getProcessRuntimeHost()
				.processes.snapshot()
				.entries.find((entry) => entry.intent.spawnId === intent.spawnId)!;
			expect(entry.aborted).toBe(true);
		} finally {
			child?.child.kill("SIGKILL");
			await child?.exited.catch(() => {});
			f.close();
		}
	},
);

test.skipIf(process.platform !== "darwin")(
	"real reload retains old spawn provenance and rejects captured pi facade",
	async () => {
		let pi!: ExtensionAPI;
		const f = await attached((api) => {
			pi = api;
		});
		try {
			await pi.exec("/bin/true", []);
			const intent = f.f.intents[0];
			const previous = getProcessRuntimeHost()
				.processes.snapshot()
				.entries.find((entry) => entry.intent.spawnId === intent.spawnId)!;
			const stalePi = pi;
			const staleFacade = pi.managedProcesses;
			await f.harness.session.reload();
			// Identity only: a deep comparison would read the stale API's throwing getters.
			expect(pi === stalePi).toBe(false);
			expect(() => staleFacade.bind(f.f.adapter)).toThrow(/retired/);
			expect(() => stalePi.managedSpawn("/bin/true", [])).toThrow(/stale/);
			const retained = getProcessRuntimeHost()
				.processes.snapshot()
				.entries.find((entry) => entry.intent.spawnId === intent.spawnId)!;
			expect(retained.intent).toEqual(previous.intent);
			expect(retained.provenance).toEqual(previous.provenance);
		} finally {
			f.close();
		}
	},
);

/** An owner whose saved lifecycle is offline: attempts are allocated but no fence can be captured. */
function offlineOwner(f: ReturnType<typeof fixture>, context: ManagedCallContext) {
	const lifecycle = {
		inspect: () => ({
			state: "pending" as const,
			hostId: "host-one",
			instanceId: "instance-one",
			incarnation: 1,
			epoch: 0,
			process: { pid: 44, birthNonce: "n" },
			conversation: context.attempt.intent.provenance.conversation,
		}),
		capture: () => {
			throw new Error("offline");
		},
		isCurrent: () => false,
		participate: () => {},
		reconcile: async () => "applied" as const,
		disconnect: () => {},
		cancel: () => {},
		track: () => () => {},
	};
	return new ManagedProcessOwner(
		{
			processes: f.registry,
			reconcileProcesses: async () => {},
			reconcileProcessAttempt: async (_adapter, target) => ({
				...target,
				through: f.registry.inspect().reconciledThrough,
			}),
		},
		lifecycle,
		async () => {},
	);
}

function plainTool(execute: ToolDefinition["execute"]): ToolDefinition {
	return { name: "plain", label: "plain", description: "fixture", parameters: Type.Object({}), execute };
}

test("captured old facade cannot bind or relabel after retirement", () => {
	const f = fixture();
	const context = f.begin("retained");
	const owner = offlineOwner(f, context);
	owner.facade.bind(f.adapter);
	const allocated = owner.claimRun("actual-claimed-agent-run")!;
	expect(allocated.attempt.intent.runId).toBe("actual-claimed-agent-run");
	expect(allocated.attempt.fence).toBeUndefined();
	expect(f.opened).toHaveLength(0);
	const retainedId = allocated.attempt.intent.attemptId;
	owner.settleRun();
	owner.retire();
	expect(f.registry.attempts.get(retainedId)!.intent.runId).toBe("actual-claimed-agent-run");
	expect(f.registry.attempts.get(retainedId)!.ended).toBe(true);
	expect(() => owner.facade.bind(f.adapter)).toThrow(/retired/);
	expect(owner.facade.inspect().through).toBeGreaterThan(0);
	expect(context.attempt.retired).toBe(true);
});

test("an owner that never bound an adapter is unaffected by retirement, a participating one fails closed", async () => {
	const f = fixture();
	const context = f.begin("retained");
	const ordinary = offlineOwner(f, context);
	ordinary.retire();
	expect(ordinary.claimRun("run")).toBeUndefined();
	expect(ordinary.toolContext("tool", "bash")).toBeUndefined();
	expect(ordinary.hookContext("tool", "bash")).toBeUndefined();
	await expect(
		ordinary.run(
			"pi-exec",
			"call",
			() => {},
			async () => "ran",
		),
	).resolves.toBe("ran");
	// Only the fixture's own attempt exists: the ordinary owner allocated nothing.
	expect(f.registry.attempts.size).toBe(1);
	const participating = offlineOwner(f, context);
	participating.facade.bind(f.adapter);
	participating.retire();
	expect(() => participating.toolContext("tool", "bash")).toThrow(/retired/);
	expect(() => participating.claimRun("run")).toThrow(/retired/);
	expect(() =>
		participating.run(
			"pi-exec",
			"call",
			() => {},
			async () => "ran",
		),
	).toThrow(/retired/);
});

test("hooks join the claimed run but never allocate; a tool call outside a run owns a standalone attempt", () => {
	const f = fixture();
	const owner = offlineOwner(f, f.begin("seed"));
	owner.facade.bind(f.adapter);
	const before = f.registry.attempts.size;
	expect(owner.hookContext("hook-call", "bash")).toBeUndefined();
	expect(f.registry.attempts.size).toBe(before);
	const alone = owner.toolContext("tool-call", "bash")!;
	expect(alone.standalone).toBe(true);
	expect(f.registry.attempts.size).toBe(before + 1);
	const run = owner.claimRun("run")!;
	const hook = owner.hookContext("hook-call", "bash")!;
	const tool = owner.toolContext("tool-call", "bash")!;
	expect(hook.attempt).toBe(run.attempt);
	expect(tool.attempt).toBe(run.attempt);
	expect([hook.standalone, tool.standalone]).toEqual([false, false]);
});

test("a tool wrapped without a managed factory inherits the enclosing scope and never ends it", async () => {
	const f = fixture();
	const outer = { ...f.begin("outer"), standalone: true };
	const tool = wrapToolDefinition(plainTool(async () => ({ content: [], details: {} })));
	await withManagedCall(outer, () => tool.execute("call", {}, undefined));
	expect(outer.attempt.ended).toBe(false);
});

test("a tool call that allocated a standalone attempt ends it on completion", async () => {
	const f = fixture();
	const owned = { ...f.begin("owned"), standalone: true };
	const tool = wrapToolDefinition(
		plainTool(async () => ({ content: [], details: {} })),
		undefined,
		() => owned,
	);
	await tool.execute("call", {}, undefined);
	expect(owned.attempt.ended).toBe(true);
});

test("a service stop aborts the signal of an in-flight managed tool call", async () => {
	const f = fixture();
	const context = f.begin("stopped");
	const started = deferred<void>();
	let sawAbort = false;
	const tool = wrapToolDefinition(
		plainTool(async (_id, _params, signal) => {
			started.resolve();
			await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
			sawAbort = true;
			return { content: [], details: {} };
		}),
		undefined,
		() => context,
	);
	const running = tool.execute("call", {}, undefined);
	await started.promise;
	const stop = f.registry.requestStop("stopped", "stop", async () => {});
	await running;
	await stop.settled;
	expect(sawAbort).toBe(true);
	expect(context.attempt.ended).toBe(true);
});
