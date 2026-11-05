import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { Container, Text, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { ExternalEventDisplayItem } from "../../../src/core/external-event-projection.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import type { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { canonical } from "../../helpers/external-events.ts";
import { attachCoordination } from "../../helpers/interactive-coordination.ts";

const TOOL_CALL_ID = "tool-4167";
const TOOL_NAME = "slow_tool";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

type RenderSessionItems = (
	this: RenderSessionContextThis,
	items: AgentMessage[],
	options?: { updateFooter?: boolean; populateHistory?: boolean },
) => void;

type RenderSessionContextThis = {
	pendingTools: Map<string, ToolExecutionComponent>;
	chatContainer: Container;
	runtimeHost: { session: RenderSessionContextThis["session"] };
	footer: { invalidate(): void };
	programStatus: { handleEvent(): void };
	ui: TUI;
	settingsManager: {
		getShowImages(): boolean;
		getImageWidthCells(): number;
		getShowCacheMissNotices(): boolean;
	};
	sessionManager: { getCwd(): string; getEntries(): SessionEntry[] };
	session: {
		retryAttempt: number;
		modelRegistry: { find(provider: string, modelId: string): undefined };
		getExternalEventView(entries: SessionEntry[]): ExternalEventDisplayItem[];
		sessionManager: { getEntries(): SessionEntry[]; buildContextEntries(): SessionEntry[] };
	};
	toolOutputExpanded: boolean;
	isInitialized: boolean;
	updateEditorBorderColor(): void;
	getRegisteredToolDefinition(toolName: string): undefined;
	maybeShowAssistantDiagnostics(message: AssistantMessage): void;
	addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void;
	renderSessionItems: RenderSessionItems;
	addCustomEntryToChat(entry: unknown): void;
};

type RenderSessionEntries = (
	this: RenderSessionContextThis,
	entries: SessionEntry[],
	options?: { updateFooter?: boolean; populateHistory?: boolean },
) => void;

function createFakeInteractiveModeThis(entries: SessionEntry[]): RenderSessionContextThis {
	const chatContainer = new Container();
	const session: RenderSessionContextThis["session"] = {
		retryAttempt: 0,
		modelRegistry: { find: () => undefined },
		getExternalEventView: (visible) => visible.map((entry) => ({ type: "entry", entry })),
		sessionManager: { getEntries: () => entries, buildContextEntries: () => entries },
	};
	return {
		pendingTools: new Map<string, ToolExecutionComponent>(),
		chatContainer,
		runtimeHost: { session },
		footer: { invalidate: vi.fn() },
		programStatus: { handleEvent: vi.fn() },
		ui: { requestRender: vi.fn() } as unknown as TUI,
		settingsManager: {
			getShowImages: () => false,
			getImageWidthCells: () => 60,
			getShowCacheMissNotices: () => false,
		},
		sessionManager: { getCwd: () => process.cwd(), getEntries: () => [] },
		session,
		toolOutputExpanded: false,
		isInitialized: true,
		updateEditorBorderColor: vi.fn(),
		getRegisteredToolDefinition: (_toolName: string) => undefined,
		maybeShowAssistantDiagnostics: vi.fn(),
		renderSessionItems: (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems,
		addCustomEntryToChat: (InteractiveMode.prototype as unknown as { addCustomEntryToChat(entry: unknown): void })
			.addCustomEntryToChat,
		addMessageToChat(message: AgentMessage) {
			chatContainer.addChild(new Text(message.role, 0, 0));
		},
	};
}

function createAssistantToolCallMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: TOOL_CALL_ID,
				name: TOOL_NAME,
				arguments: { delayMs: 10_000 },
			},
		],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createSessionEntries(messages: AgentMessage[]): SessionEntry[] {
	let parentId: string | null = null;
	return messages.map((message, index) => {
		const entry: SessionEntry = {
			type: "message",
			id: `entry-${index}`,
			parentId,
			timestamp: new Date().toISOString(),
			message,
		};
		parentId = entry.id;
		return entry;
	});
}

describe("InteractiveMode.renderSessionEntries", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("remounts the same card and reconstructs the unresolved batch after a rebuild", () => {
		const entries = createSessionEntries([createAssistantToolCallMessage()]);
		const fakeThis = createFakeInteractiveModeThis(entries);
		const coordination = attachCoordination(fakeThis);
		const card = {
			type: "external_event" as const,
			key: "event",
			sourceEntryId: "canonical",
			record: canonical(),
			state: "pending" as const,
			verified: true,
			reason: null,
			location: "shelf" as const,
		};
		fakeThis.session.getExternalEventView = (visible) => [
			...visible.map((entry) => ({ type: "entry" as const, entry })),
			card,
		];
		const renderSessionEntries = (
			InteractiveMode.prototype as unknown as { renderSessionEntries: RenderSessionEntries }
		).renderSessionEntries;
		const expectCardAboveBatch = () => {
			const children = fakeThis.chatContainer.children;
			expect(children).toHaveLength(3);
			expect(children[0]).toBe(original);
			expect(children[1]).toBeInstanceOf(Text);
			expect(children[2]).toBe(fakeThis.pendingTools.get(TOOL_CALL_ID));
		};
		renderSessionEntries.call(fakeThis, entries);
		const original = coordination.getCardComponent(card.key);
		expect(original).toBeDefined();
		expectCardAboveBatch();
		fakeThis.chatContainer.clear();
		renderSessionEntries.call(fakeThis, entries);
		expect(coordination.getCardComponent(card.key)).toBe(original);
		expectCardAboveBatch();
		// A live refresh places shelf cards above the reconstructed batch, not at the end.
		coordination.refresh();
		expectCardAboveBatch();
	});
});
