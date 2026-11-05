/**
 * Session coordination in interactive mode: Escape cancels coordination, refused session
 * replacements report a status, and external event cards render in the transcript.
 *
 * InteractiveMode owns one instance and calls it at a few points; everything else lives here.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Component, type Container, isKeyRelease, matchesKey, type TUI } from "@earendil-works/pi-tui";
import type { AgentSession, AgentSessionEvent } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type { ExternalEventCard } from "../../core/external-event-projection.ts";
import { readExternalEntry } from "../../core/external-event-records.ts";
import type { CustomEntry, SessionEntry } from "../../core/session-manager.ts";
import { ExternalEventComponent } from "./components/external-event.ts";
import { ExternalEventLayer } from "./external-event-layer.ts";

export const REPLACEMENT_BUSY_STATUS = "A session replacement is already in progress";

/** Slash commands that replace the session. Refused up front so the editor keeps the command. */
const REPLACEMENT_COMMANDS = new Set(["/new", "/reload", "/fork", "/clone", "/resume", "/import"]);

/** Custom entry type of the transcript items that stand in for external event cards. */
const CARD_ENTRY = "pi.external-event-card";

/** Identify a physical Escape key press (excluding key-release packets) for pre-routing coordination cancellation. */
export function isCoordinationEscape(data: string): boolean {
	if (isKeyRelease(data)) return false;
	return matchesKey(data, "escape");
}

/** What InteractiveCoordination reads from InteractiveMode. Getters, because the values change. */
export interface InteractiveCoordinationHost {
	runtimeHost(): AgentSessionRuntime;
	ui(): TUI;
	chat(): Container;
	outputPad(): number;
	toolOutputExpanded(): boolean;
	showStatus(message: string): void;
	showError(message: string): void;
	invalidateFooter(): void;
}

export class InteractiveCoordination {
	private readonly cards = new ExternalEventLayer();
	private cardSession: AgentSession | undefined;
	/** Entries rendered since the transcript was last cleared, in display order. */
	private rendered: SessionEntry[] = [];
	/** First transcript component of each rendered entry, by entry id. */
	private readonly anchors = new Map<string, Component>();
	private messageComponents = new WeakMap<AgentMessage, Component>();
	/** First component of the current turn's batch (assistant message and its tools). */
	private activeBatch: Component | undefined;
	/** A message started live; its component is mounted by the time the next event arrives. */
	private pending: { message: AgentMessage; index: number } | undefined;
	private openItem: { item: object; id: string | undefined; start: number } | undefined;
	private readonly assistantForTool = new Map<string, Component>();
	private shelf: ExternalEventComponent[] = [];
	private readonly host: InteractiveCoordinationHost;

	constructor(host: InteractiveCoordinationHost) {
		this.host = host;
	}

	/** Bind once the TUI exists. */
	attach(): void {
		this.host.ui().addInputObserver((data) => {
			if (isCoordinationEscape(data)) this.host.runtimeHost().session.coordinationScheduler.cancel();
		});
		this.host.runtimeHost().onReplacementRefused = () => this.host.showStatus(REPLACEMENT_BUSY_STATUS);
	}

	/** Refuse a replacement command while another replacement runs, before the editor or a selector changes. */
	refuseReplacementCommand(text: string): boolean {
		if (!REPLACEMENT_COMMANDS.has(text) && !text.startsWith("/import ")) return false;
		const runtimeHost = this.host.runtimeHost();
		if (!runtimeHost.isReplacementInProgress && !runtimeHost.session.isReplacementInProgress) return false;
		this.host.showStatus(REPLACEMENT_BUSY_STATUS);
		return true;
	}

	/** Called for every session event before InteractiveMode renders it. */
	observe(event: AgentSessionEvent): void {
		this.resolvePending();
		switch (event.type) {
			case "request_suppressed":
				this.host.showError(`Request suppressed: ${event.errorMessage}`);
				break;
			case "external_events_changed":
				this.refresh();
				break;
			case "turn_end":
			case "agent_end":
				this.activeBatch = undefined;
				break;
			case "message_start":
				if (event.message.role === "user" || event.message.role === "assistant") {
					this.pending = { message: event.message, index: this.host.chat().children.length };
				}
				break;
			case "message_end":
				if (event.message.role === "assistant" && this.activeBatch) {
					this.messageComponents.set(event.message, this.activeBatch);
				}
				break;
		}
	}

	/** Entries for a transcript render: external records become card entries in display position. */
	project(entries: SessionEntry[]): SessionEntry[] {
		const session = this.currentSession();
		if (this.host.chat().children.length === 0) this.resetTranscript();
		this.rendered = this.rendered.concat(entries);
		return session
			.getExternalEventView(entries)
			.map((item): SessionEntry => (item.type === "entry" ? item.entry : cardEntry(item)));
	}

	/** Render a card entry or skip an external record. Returns whether the entry was handled. */
	renderCustomEntry(entry: CustomEntry): boolean {
		if (entry.customType !== CARD_ENTRY) return readExternalEntry(entry) !== undefined;
		const card = entry.data as ExternalEventCard;
		const chat = this.host.chat();
		const component = this.cards.getOrCreate(card, (value) => this.createCard(value));
		component.setOutputPad(this.host.outputPad());
		// A boundary compaction renders the transcript in two passes; keep one mount.
		chat.removeChild(component);
		chat.addChild(component);
		if (card.location === "shelf") this.shelf.push(component);
		return true;
	}

	/** Called before each transcript item renders, to note which component it starts with. */
	beginItem(item: object, messageMeta?: ReadonlyMap<AgentMessage, { id: string }>): void {
		this.closeItem();
		const id =
			"role" in item ? messageMeta?.get(item as AgentMessage)?.id : "id" in item ? String(item.id) : undefined;
		this.openItem = { item, id, start: this.host.chat().children.length };
	}

	/** Called after the transcript items render. Keeps an unfinished tool batch below the cards. */
	endItems(pendingTools: ReadonlyMap<string, Component>): void {
		this.closeItem();
		for (const toolCallId of pendingTools.keys()) this.activeBatch ??= this.assistantForTool.get(toolCallId);
		const chat = this.host.chat();
		if (this.activeBatch) {
			for (const card of this.shelf) {
				chat.removeChild(card);
				const index = chat.children.indexOf(this.activeBatch);
				if (index < 0) chat.addChild(card);
				else chat.children.splice(index, 0, card);
			}
		}
		this.shelf = [];
		this.assistantForTool.clear();
	}

	/** Re-place the cards after the external event view changed. */
	refresh(): void {
		this.resolvePending();
		const session = this.currentSession();
		for (const entry of session.sessionManager.getEntries()) {
			if (entry.type !== "message") continue;
			const component = this.messageComponents.get(entry.message);
			if (component) this.anchors.set(entry.id, component);
		}
		this.cards.reconcile({
			container: this.host.chat(),
			items: session.getExternalEventView(this.visibleEntries(session)),
			entryAnchors: this.anchors,
			beforeActive: this.activeBatch,
			createCard: (card) => this.createCard(card),
		});
		this.host.invalidateFooter();
		this.host.ui().requestRender();
	}

	getCardComponent(key: string): ExternalEventComponent | undefined {
		return this.cards.getComponent(key);
	}

	private currentSession(): AgentSession {
		const session = this.host.runtimeHost().session;
		if (session !== this.cardSession) {
			this.cardSession = session;
			this.cards.clear();
		}
		return session;
	}

	/** Rendered entries in display order, then entries persisted since, in context order. */
	private visibleEntries(session: AgentSession): SessionEntry[] {
		const rendered = new Set(this.rendered.map((entry) => entry.id));
		const added = session.sessionManager.buildContextEntries().filter((entry) => !rendered.has(entry.id));
		return [...this.rendered, ...added];
	}

	private resetTranscript(): void {
		this.rendered = [];
		this.anchors.clear();
		this.messageComponents = new WeakMap();
		this.activeBatch = undefined;
		this.pending = undefined;
		this.openItem = undefined;
		this.assistantForTool.clear();
		this.shelf = [];
	}

	private resolvePending(): void {
		const pending = this.pending;
		this.pending = undefined;
		const component = pending && this.host.chat().children[pending.index];
		if (!pending || !component) return;
		this.messageComponents.set(pending.message, component);
		if (pending.message.role === "assistant") this.activeBatch = component;
	}

	private closeItem(): void {
		const open = this.openItem;
		this.openItem = undefined;
		const component = open && this.host.chat().children[open.start];
		if (!open || !component) return;
		if (open.id) this.anchors.set(open.id, component);
		if (!("role" in open.item)) return;
		const message = open.item as AgentMessage;
		this.messageComponents.set(message, component);
		if (message.role !== "assistant") return;
		for (const content of message.content) {
			if (content.type === "toolCall") this.assistantForTool.set(content.id, component);
		}
	}

	private createCard(card: ExternalEventCard): ExternalEventComponent {
		const component = new ExternalEventComponent(card, this.host.outputPad());
		component.setExpanded(this.host.toolOutputExpanded());
		return component;
	}
}

function cardEntry(card: ExternalEventCard): CustomEntry<ExternalEventCard> {
	return {
		type: "custom",
		customType: CARD_ENTRY,
		id: `${CARD_ENTRY}:${card.key}`,
		parentId: null,
		timestamp: "",
		data: card,
	};
}
