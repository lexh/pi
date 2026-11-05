import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { ExternalEventCard } from "../src/core/external-event-projection.ts";
import { ExternalEventComponent } from "../src/modes/interactive/components/external-event.ts";
import { ExternalEventLayer } from "../src/modes/interactive/external-event-layer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { canonical } from "./helpers/external-events.ts";

const card: ExternalEventCard = {
	type: "external_event",
	key: '["recipient","event"]',
	sourceEntryId: "event",
	record: canonical(),
	state: "pending",
	verified: true,
	reason: null,
	location: "shelf",
};

beforeAll(() => initTheme("dark"));

describe("external event card", () => {
	it("renders explicit state and preserves the exact envelope through updates", () => {
		const component = new ExternalEventComponent(card);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("pending");
		component.setExpanded(true);
		for (const width of [20, 40, 80]) {
			const lines = component.render(width);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(card.record.envelope).toBe(canonical().envelope);
		}
		expect(stripAnsi(component.render(80).join("\n"))).toContain("UNREAD_BODY_7d81");
		component.setCard({ ...card, state: "dropped", reason: "gone" });
		expect(stripAnsi(component.render(80).join("\n"))).toContain("UNREAD_BODY_7d81");
		component.invalidate();
		expect(stripAnsi(component.render(80).join("\n"))).toContain("dropped");
	});

	it("keeps terminal and inherited cards inspectable without an unread label", () => {
		const terminal = new ExternalEventComponent({
			...card,
			state: "dropped",
			verified: false,
			reason: "service declined",
		});
		const collapsed = stripAnsi(terminal.render(80).join("\n"));
		expect(collapsed).toContain("dropped, unverified");
		expect(collapsed).toContain("service declined");
		expect(collapsed).not.toContain("UNREAD_BODY_7d81");
		terminal.setExpanded(true);
		expect(stripAnsi(terminal.render(80).join("\n"))).toContain("UNREAD_BODY_7d81");
		const inherited: ExternalEventCard = {
			...card,
			state: "inherited",
			location: "inline",
			record: {
				...canonical(),
				kind: "inherited",
				origin: {
					sessionId: "source-session",
					entryId: "source-entry",
					requestId: "original-request",
					instanceId: "instance",
					epoch: 0,
					branchAnchor: null,
				},
				copiedFrom: { sessionId: "source-session", entryId: "source-entry" },
			},
		};
		const component = new ExternalEventComponent(inherited);
		component.setExpanded(true);
		const output = stripAnsi(component.render(80).join("\n"));
		expect(output).toContain("recipient");
		expect(output).toContain("original-request");
		expect(output).toContain("source-session");
		expect(output).not.toContain("pending");
		for (const width of [20, 40, 80]) {
			expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
			expect(inherited.record.envelope).toBe(canonical().envelope);
		}
	});
});

describe("external event layer", () => {
	it("retains keyed cards and ordinary component identity", () => {
		const layer = new ExternalEventLayer();
		const container = new Container();
		const assistant = new Text("assistant", 0, 0);
		const tool = new Text("tool", 0, 0);
		container.addChild(assistant);
		container.addChild(tool);
		const createCard = (card: ExternalEventCard) => new ExternalEventComponent(card);
		layer.reconcile({ container, items: [card], entryAnchors: new Map(), beforeActive: assistant, createCard });
		const original = layer.getComponent(card.key);
		layer.reconcile({
			container,
			items: [{ ...card, state: "expired", verified: false }],
			entryAnchors: new Map(),
			beforeActive: assistant,
			createCard,
		});
		expect(layer.getComponent(card.key)).toBe(original);
		expect(container.children.filter((child) => child === assistant)).toHaveLength(1);
		expect(container.children.filter((child) => child === tool)).toHaveLength(1);
		expect(container.children.indexOf(assistant)).toBeLessThan(container.children.indexOf(tool));
	});
});
