import { InteractiveCoordination } from "../../src/modes/interactive/interactive-coordination.ts";

/**
 * Give a prototype-built InteractiveMode test double the coordination object the constructor
 * would create, reading the double's own fields.
 */
export function attachCoordination(mode: object): InteractiveCoordination {
	const fields = mode as Record<string, any>;
	const coordination = new InteractiveCoordination({
		runtimeHost: () => fields.runtimeHost,
		ui: () => fields.ui,
		chat: () => fields.chatContainer,
		outputPad: () => fields.outputPad ?? 1,
		toolOutputExpanded: () => fields.toolOutputExpanded ?? false,
		showStatus: (message) => fields.showStatus(message),
		showError: (message) => fields.showError(message),
		invalidateFooter: () => fields.footer?.invalidate(),
	});
	fields.coordination = coordination;
	return coordination;
}
