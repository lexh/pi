// Read-only local assertions. Service observations remain authoritative.
interface NativeLibrary {
	functions: { sysctl(mib: Buffer, count: number, out: Buffer, size: Buffer, unused: null, length: number): number };
}
interface Ffi {
	dlopen(path: string, definitions: Record<string, { arguments: string[]; return: string }>): NativeLibrary;
}
let native: NativeLibrary | null | undefined;

export function parseLocalBirth(out: Buffer, length: bigint, pid: number): string | null {
	if (length !== 648n || out.length !== 648 || out.readInt32LE(40) !== pid) return null;
	const seconds = out.readBigInt64LE(0);
	const micros = out.readInt32LE(8);
	if (seconds < 0n || micros < 0 || micros >= 1_000_000) return null;
	return `kinfo:${seconds * 1_000_000n + BigInt(micros)}`;
}
export function readLocalProcessBirth(pid: number): string | null {
	if (process.platform !== "darwin" || process.arch !== "arm64") return null;
	try {
		if (native === undefined) {
			// Optional runtime trust boundary: do not statically import an unavailable builtin.
			const ffi = process.getBuiltinModule("node:ffi") as Ffi | undefined;
			native =
				ffi?.dlopen("/usr/lib/libSystem.B.dylib", {
					sysctl: { arguments: ["buffer", "uint32", "buffer", "buffer", "pointer", "uint64"], return: "int32" },
				}) ?? null;
		}
		if (!native) return null;
		const mib = Buffer.alloc(16);
		[1, 14, 1, pid].forEach((value, index) => {
			mib.writeInt32LE(value, index * 4);
		});
		const out = Buffer.alloc(648);
		const size = Buffer.alloc(8);
		size.writeBigUInt64LE(648n);
		if (native.functions.sysctl(mib, 4, out, size, null, 0) !== 0) return null;
		return parseLocalBirth(out, size.readBigUInt64LE(), pid);
	} catch {
		return null;
	}
}
