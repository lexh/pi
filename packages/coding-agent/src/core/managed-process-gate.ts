import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import type { Writable } from "node:stream";

export interface DescriptorGate {
	child: ChildProcess;
	release(): void;
	cancel(): void;
}
const GATE = 'IFS= read -r release <&3 || exit 125; [ "$release" = go ] || exit 125; exec 3<&-; exec "$@"';

export function spawnGate(command: string, args: readonly string[], options: SpawnOptions): DescriptorGate {
	const stdio = options.stdio ?? ["ignore", "pipe", "pipe"];
	if (!Array.isArray(stdio) || stdio.length !== 3)
		throw new Error("Managed spawn reserves fd 3 and requires three stdio entries");
	const child = spawn("/bin/sh", ["-c", GATE, "pi-managed-gate", command, ...args], {
		...options,
		shell: false,
		detached: true,
		stdio: [...stdio, "pipe"],
	});
	// fd 3 is the writable parent half of the gate pipe.
	child.on("error", () => {});
	const descriptor = child.stdio[3] as Writable | null;
	descriptor?.on("error", () => {});
	let decided = false;
	return {
		child,
		release() {
			if (!decided) {
				decided = true;
				descriptor?.end("go\n");
			}
		},
		cancel() {
			if (!decided) {
				decided = true;
				descriptor?.end();
			}
		},
	};
}
