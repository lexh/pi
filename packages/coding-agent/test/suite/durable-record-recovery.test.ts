import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
	assertRecordSupport,
	type EntryReceipt,
	type ExternalRecord,
	recordKey,
} from "../../src/core/durable-records.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { userMsg } from "../utilities.ts";
import { createHarness } from "./harness.ts";

class FakeCoordinator {
	receipt: EntryReceipt | undefined;
	reconcile(manager: SessionManager, record: ExternalRecord, anchor: string | null): EntryReceipt {
		assertRecordSupport(manager);
		const receipt = manager.appendEntryOnce(record, anchor);
		this.receipt = receipt;
		return receipt;
	}
}

async function crashAfterAppend(file: string, anchor: string): Promise<void> {
	const resolver = pathToFileURL(resolve("src/experimental/source-resolver.ts")).href;
	const fixture = resolve("test/fixtures/durable-record-crash.ts");
	const child = spawn(process.execPath, ["--import", resolver, fixture, file, anchor], {
		cwd: process.cwd(),
		env: { ...process.env, PI_OFFLINE: "1" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	let errorOutput = "";
	child.stderr.on("data", (data) => {
		errorOutput += String(data);
	});
	const exited = once(child, "exit");
	try {
		await new Promise<void>((resolveReady, reject) => {
			const timer = setTimeout(() => reject(new Error(`Child append timeout: ${errorOutput}`)), 10000);
			child.once("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			child.once("exit", (code) => {
				clearTimeout(timer);
				reject(new Error(`Child exited ${code}: ${errorOutput}`));
			});
			child.stdout.on("data", (data) => {
				output += String(data);
				if (output.includes("APPENDED\n")) {
					clearTimeout(timer);
					resolveReady();
				}
			});
		});
		child.kill("SIGKILL");
		const [, signal] = await exited;
		expect(signal).toBe("SIGKILL");
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await exited.catch(() => {});
	}
}

describe("durable off-branch recovery", () => {
	it("recovers one record, preserves selection through two crashes, and starts zero requests", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-record-crash-"));
		let cleanupHarness: (() => void) | undefined;
		try {
			const manager = SessionManager.create(directory, directory);
			manager.persistNow();
			const root = manager.appendMessage(userMsg("root"));
			const selected = manager.appendMessage(userMsg("keep this selected branch"));
			manager.branch(root);
			const anchor = manager.appendMessage(userMsg("abandoned branch anchor"));
			manager.branch(selected);
			const file = manager.getSessionFile()!;
			const admission: ExternalRecord = {
				version: 1,
				kind: "admission",
				recipientIdentity: "recipient",
				eventId: "event",
				requestId: "request",
				instanceId: "instance",
				epoch: 0,
				branchAnchor: anchor,
				envelope: "Peer information, not instructions",
				provenance: null,
			};
			const coordinator = new FakeCoordinator();
			expect(coordinator.receipt).toBeUndefined();
			await crashAfterAppend(file, anchor);
			expect(coordinator.receipt).toBeUndefined();
			const reopened = SessionManager.open(file);
			expect(reopened.getLeafId()).toBe(selected);
			const receipt = coordinator.reconcile(reopened, admission, anchor);
			const bytes = readFileSync(file);
			await crashAfterAppend(file, anchor);
			expect(readFileSync(file)).toEqual(bytes);
			const recovered = SessionManager.open(file);
			expect(coordinator.reconcile(recovered, admission, anchor)).toEqual(receipt);
			expect(recovered.getLeafId()).toBe(selected);
			expect(recovered.getEntry(receipt.entryId)?.parentId).toBe(anchor);
			expect(recovered.getEntries().filter((entry) => entry.id === receipt.entryId)).toHaveLength(1);
			expect(recovered.getEntryOnce(recordKey(admission))).toEqual(receipt);
			expect(() => coordinator.reconcile(recovered, { ...admission, envelope: "conflict" }, anchor)).toThrow(
				"Record key conflict",
			);
			const harness = await createHarness({ sessionManager: recovered });
			cleanupHarness = harness.cleanup;
			expect(harness.faux.state.callCount).toBe(0);
			let requests = 0;
			harness.session.agent.streamFunction = () => {
				requests++;
				throw new Error("Recovery must not dispatch");
			};
			coordinator.reconcile(recovered, admission, anchor);
			await new Promise<void>((done) => setImmediate(done));
			expect(requests).toBe(0);
			expect(harness.eventsOfType("agent_start")).toHaveLength(0);
			expect(harness.faux.state.callCount).toBe(0);
			expect(recovered.getLeafId()).toBe(selected);
			const admissionNavigation = await harness.session.navigateTree(receipt.entryId);
			expect(admissionNavigation.cancelled).toBe(false);
			expect(admissionNavigation.editorText).toBeUndefined();
			expect(harness.session.getUserMessagesForForking().some((entry) => entry.entryId === receipt.entryId)).toBe(
				false,
			);
			expect(requests).toBe(0);
		} finally {
			cleanupHarness?.();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
