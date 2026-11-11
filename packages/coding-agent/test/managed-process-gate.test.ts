import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { expect, test } from "vitest";
import { spawnGate } from "../src/core/managed-process-gate.ts";

for (const decision of ["release", "cancel", "invalid"] as const) {
	test(`gate ${decision} preserves descriptor discipline`, async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-gate-"));
		const marker = join(directory, "started");
		const literal = "quotes'\"\n$(touch forbidden)";
		const gate = spawnGate(
			"/bin/sh",
			["-c", 'test ! -e /dev/fd/3 || exit 9; printf "%s" "$2" > "$1"', "sh", marker, literal],
			{ cwd: directory, env: { ...process.env, LITERAL: "$(touch forbidden)" }, stdio: ["ignore", "pipe", "pipe"] },
		);
		const exited = once(gate.child, "exit");
		try {
			expect(existsSync(marker)).toBe(false);
			if (decision === "release") gate.release();
			else if (decision === "cancel") {
				gate.cancel();
				gate.release();
			} else (gate.child.stdio[3] as Writable).end("wrong\n");
			const [code] = await exited;
			expect(code).toBe(decision === "release" ? 0 : 125);
			expect(existsSync(marker)).toBe(decision === "release");
			if (decision === "release") expect(readFileSync(marker, "utf8")).toBe(literal);
			expect(existsSync(join(directory, "forbidden"))).toBe(false);
		} finally {
			gate.cancel();
			gate.child.kill("SIGKILL");
			await exited;
			rmSync(directory, { recursive: true, force: true });
		}
	});
}

test("launcher death supplies EOF without executing the command", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-gate-eof-"));
	const marker = join(directory, "started");
	const script = `const {spawn}=require('node:child_process');const gate=spawn('/bin/sh',['-c','IFS= read -r release <&3 || exit 125; [ "$release" = go ] || exit 125; exec 3<&-; exec "$@"','gate','/bin/sh','-c','echo wrong > "$1"','sh',${JSON.stringify(marker)}],{detached:true,stdio:['ignore','ignore','ignore','pipe']});gate.once('spawn',()=>process.send({ready:true}));setInterval(()=>{},100000);`;
	const launcher = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
	const ended = once(launcher, "exit");
	try {
		await once(launcher, "message");
		launcher.kill("SIGKILL");
		await ended;
		// A separate service kqueue assertion for exact 125 is Phase 1's gate EOF test.
		// Here a command marker cannot appear after launcher death or during the bounded drain.
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(existsSync(marker)).toBe(false);
	} finally {
		launcher.kill("SIGKILL");
		rmSync(directory, { recursive: true, force: true });
	}
});

test("reserved descriptors reject caller-supplied extra fds", () => {
	expect(() => spawnGate("/bin/true", [], { stdio: ["ignore", "ignore", "ignore", "pipe"] })).toThrow(/fd 3/);
});

test("bound missing target reports the gate shell's actual status 126 and diagnostic", async () => {
	const gate = spawnGate("/definitely/missing/pi-managed-target", [], { stdio: ["ignore", "pipe", "pipe"] });
	const exited = once(gate.child, "exit");
	let diagnostic = "";
	gate.child.stderr!.on("data", (chunk) => {
		diagnostic += chunk;
	});
	gate.release();
	expect((await exited)[0]).toBe(126);
	expect(diagnostic).toContain("/definitely/missing/pi-managed-target");
});
test("a genuine gated target exit 127 is also failure, never successful work", async () => {
	const gate = spawnGate("/bin/sh", ["-c", "exit 127"], { stdio: ["ignore", "pipe", "pipe"] });
	const exited = once(gate.child, "exit");
	gate.release();
	expect((await exited)[0]).toBe(127);
});
