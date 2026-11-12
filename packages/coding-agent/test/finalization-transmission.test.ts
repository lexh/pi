import { expect, test } from "vitest";
import { ManagedProcessOwner } from "../src/core/managed-process-owner.ts";
import type { ProcessJournalPage } from "../src/core/managed-process-types.ts";
import type { BatchCertificate } from "../src/core/task-finalization.ts";
import { fixture } from "./helpers/managed-process.ts";

for (const withSpawn of [false, true]) {
	test(`ended original run drains frozen target before authenticated send, spawn=${withSpawn}`, async () => {
		const sent: BatchCertificate[] = [];
		const pages: ProcessJournalPage[] = [];
		let failReplay = true;
		let failFinalize = true;
		let siblingActivity = 0;
		const f = fixture({
			reconcile: async (page) => {
				pages.push(structuredClone(page));
				if (failReplay) {
					failReplay = false;
					throw new Error("replay response lost");
				}
				// A sibling stays active on every retry/drain. Global local through never quiesces.
				if (siblingActivity++ < 10) f.registry.gap(f.begin(`sibling-${siblingActivity}`), "unsupported-tool");
				return { acknowledgedThrough: page.complete ? page.through : page.records.at(-1)!.sequence, cleanup: [] };
			},
			finalize: async (certificate) => {
				sent.push(structuredClone(certificate));
				expect(
					pages.some(
						(page) =>
							page.complete &&
							page.through >= certificate.registryThrough &&
							page.records.some(
								(record) =>
									record.kind === "attempt" &&
									record.value.attemptId === certificate.attemptId &&
									record.value.ended,
							),
					),
				).toBe(true);
				if (failFinalize) {
					failFinalize = false;
					throw new Error("finalization response lost");
				}
				return "committed";
			},
		});
		const original = f.registry.begin(
			{
				operationId: "open-original",
				attemptId: "original",
				marker: "original-marker",
				runId: "original-agent-run",
				provenance: {
					hostId: "host-one",
					instanceId: "never-attached",
					incarnation: 2,
					conversation: { piSessionId: "old", sessionFile: "/saved/old.jsonl" },
				},
			},
			undefined,
			f.adapter,
		);
		await original.opening.catch(() => {});
		const context = { attempt: original, source: "bash" as const, toolCallId: "tool" };
		if (withSpawn) {
			const entry = f.registry.record(
				{ ...f.intent(context, "original-spawn"), marker: "original-marker" },
				context,
				"kinfo:1000000",
			)!;
			f.registry.released(entry);
			f.registry.callEnded(entry, context, false);
		}
		const auth = { hostId: "host-one", credential: "PRIVATE", process: { pid: 44, birthNonce: "n" } };
		// Older frozen live image.
		await expect(f.registry.reconcile(f.adapter, auth)).rejects.toThrow("replay response lost");
		f.registry.end(original);
		f.registry.retireRuntime("never-attached");
		const host = {
			processes: f.registry,
			taskFinalizations: f.taskFinalizations,
			reconcileProcesses: (adapter: typeof f.adapter) => f.registry.reconcile(adapter, auth),
			reconcileProcessAttempt: (adapter: typeof f.adapter, target: { attemptId: string; version: number }) =>
				f.registry.reconcileAttempt(target, adapter, auth),
		};
		const lifecycle = {
			inspect: () => ({
				state: "pending" as const,
				hostId: "host-one",
				instanceId: "successor",
				incarnation: 3,
				epoch: 0,
				process: { pid: 44, birthNonce: "n" },
				conversation: { piSessionId: "new", sessionFile: "/saved/new.jsonl" },
			}),
			capture: () => {
				throw new Error("Successor fence must never be recaptured");
			},
			isCurrent: () => false,
			participate: () => {},
			reconcile: async () => "applied" as const,
			disconnect: () => {},
			cancel: () => {},
			track: () => () => {},
		};
		const owner = new ManagedProcessOwner(host, lifecycle, async () => {});
		owner.facade.bind(f.adapter);
		const draft: BatchCertificate = {
			operationId: "finish",
			attemptId: "original",
			runId: "original-agent-run",
			registryThrough: f.registry.through,
			claim: "claimed-success",
			declarationToolCallId: "declare",
			toolResults: [{ toolCallId: "declare", isError: false }],
			declarationBeforeResults: false,
		};
		await expect(owner.commitFinalization(draft)).rejects.toThrow("finalization response lost");
		// Byte-identical response-loss replay before the covering image.
		expect(pages[1]).toEqual(pages[0]);
		f.registry.gap(f.begin("after-send"), "unsupported-tool");
		const reloaded = new ManagedProcessOwner(host, lifecycle, async () => {});
		reloaded.facade.bind(f.adapter);
		await expect(reloaded.commitFinalization(draft)).resolves.toBe("committed");
		expect(sent).toHaveLength(2);
		expect(sent[1]).toEqual(sent[0]);
		expect(sent[0].registryThrough).toBeLessThan(f.registry.through);
		expect(JSON.stringify(sent)).not.toMatch(/PRIVATE|generationToken|credential|fence/);
		await expect(reloaded.commitFinalization({ ...draft, runId: "successor" })).rejects.toThrow(
			/original ended agent run/,
		);
	});
}
