import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fsyncSync,
	ftruncateSync,
	linkSync,
	openSync,
	readSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { TextDecoder } from "node:util";
import { validateStoredSession } from "./durable-records.ts";

export function installSnapshot(path: string, entries: readonly unknown[], create: boolean): void {
	const temporary = `${path}.tmp-${randomUUID()}`;
	const fd = openSync(temporary, "wx", 0o600);
	try {
		for (const entry of entries) writeFileSync(fd, `${JSON.stringify(entry)}\n`);
		fsyncSync(fd);
	} catch (error) {
		closeSync(fd);
		unlinkSync(temporary);
		throw error;
	}
	closeSync(fd);
	try {
		if (create) {
			linkSync(temporary, path);
			unlinkSync(temporary);
		} else {
			renameSync(temporary, path);
		}
		const directory = openSync(dirname(path), "r");
		try {
			fsyncSync(directory);
		} finally {
			closeSync(directory);
		}
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {
			/* Installation may already have moved it. */
		}
		throw error;
	}
}

export function appendDurable(path: string, entries: readonly unknown[]): void {
	// Deliberately omit O_CREAT: a missing transcript must not become a headerless file.
	const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND);
	try {
		for (const entry of entries) writeFileSync(fd, `${JSON.stringify(entry)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

export function readStrictSession(path: string, mode: "repair" | "readonly" | "strict" = "repair"): unknown[] {
	const fd = openSync(path, mode === "repair" ? "r+" : "r");
	const entries: unknown[] = [];
	const chunks: Buffer[] = [];
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const buffer = Buffer.allocUnsafe(64 * 1024);
	let offset = 0;
	let completeEnd = 0;
	let repairTail: "none" | "newline" | "truncate" = "none";
	const consume = (bytes: Buffer): void => {
		const line = decoder.decode(bytes);
		if (line.trim()) entries.push(JSON.parse(line));
	};
	try {
		while (true) {
			const count = readSync(fd, buffer, 0, buffer.length, null);
			if (!count) break;
			let start = 0;
			for (let i = 0; i < count; i++) {
				if (buffer[i] !== 0x0a) continue;
				chunks.push(Buffer.from(buffer.subarray(start, i)));
				try {
					consume(Buffer.concat(chunks));
				} catch {
					throw new Error(`Malformed complete record in ${path} at byte ${completeEnd}`);
				}
				chunks.length = 0;
				completeEnd = offset + i + 1;
				start = i + 1;
			}
			if (start < count) chunks.push(Buffer.from(buffer.subarray(start, count)));
			offset += count;
		}
		if (chunks.length) {
			const suffix = Buffer.concat(chunks);
			let complete = suffix.toString("utf8").trim().length > 0;
			if (complete) {
				try {
					consume(suffix);
				} catch {
					complete = false;
				}
			}
			if (!complete && mode === "strict") throw new Error(`Incomplete tail in ${path}`);
			if (mode === "repair") repairTail = complete ? "newline" : "truncate";
		}
		// Semantic corruption is not a torn suffix, even when its JSON has no final LF.
		validateStoredSession(entries);
		if (repairTail === "newline") {
			const appendFd = openSync(path, constants.O_WRONLY | constants.O_APPEND);
			try {
				writeFileSync(appendFd, "\n");
				fsyncSync(appendFd);
			} finally {
				closeSync(appendFd);
			}
		} else if (repairTail === "truncate") {
			ftruncateSync(fd, completeEnd);
			fsyncSync(fd);
		}
		return entries;
	} finally {
		closeSync(fd);
	}
}
