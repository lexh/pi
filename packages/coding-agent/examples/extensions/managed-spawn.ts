import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function managedExample(pi: ExtensionAPI) {
	// Cooperative source audit: this extension launches only through the managed API.
	pi.declareProcessCoverage("managed");
	pi.registerTool({
		name: "managed_example",
		label: "Managed example",
		description: "Run a local no-op using managed process registration.",
		processCoverage: "managed",
		parameters: Type.Object({}),
		execute: async (_id, _params, signal) => {
			const handle = await pi.managedSpawn(process.execPath, ["-e", "process.exit(0)"], {
				signal,
				stdio: ["ignore", "ignore", "ignore"],
			});
			const exit = await handle.exited;
			return { content: [{ type: "text", text: `Local exit: ${exit.code ?? exit.signal}` }], details: { exit } };
		},
	});
}
