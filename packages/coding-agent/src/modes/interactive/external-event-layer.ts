import type { Component, Container } from "@earendil-works/pi-tui";
import type { ExternalEventCard, ExternalEventDisplayItem } from "../../core/external-event-projection.ts";
import type { ExternalEventComponent } from "./components/external-event.ts";

export interface ExternalEventMountInput {
	container: Container;
	items: readonly ExternalEventDisplayItem[];
	entryAnchors: ReadonlyMap<string, Component>;
	beforeActive?: Component;
	createCard: (card: ExternalEventCard) => ExternalEventComponent;
}

export class ExternalEventLayer {
	private readonly components = new Map<string, ExternalEventComponent>();

	getComponent(key: string): ExternalEventComponent | undefined {
		return this.components.get(key);
	}

	getOrCreate(
		card: ExternalEventCard,
		createCard: (card: ExternalEventCard) => ExternalEventComponent,
	): ExternalEventComponent {
		let component = this.components.get(card.key);
		if (!component) {
			component = createCard(card);
			this.components.set(card.key, component);
		} else component.setCard(card);
		return component;
	}

	clear(): void {
		this.components.clear();
	}

	reconcile(input: ExternalEventMountInput): void {
		const owned = new Set(this.components.values());
		input.container.children = input.container.children.filter(
			(child) => !owned.has(child as ExternalEventComponent),
		);
		for (let i = 0; i < input.items.length; i++) {
			const item = input.items[i];
			if (item.type !== "external_event") continue;
			const component = this.getOrCreate(item, input.createCard);
			let before: Component | undefined;
			if (item.location === "inline") {
				for (let j = i + 1; j < input.items.length; j++) {
					const next = input.items[j];
					if (next.type !== "entry") continue;
					before = input.entryAnchors.get(next.entry.id);
					if (before && input.container.children.includes(before)) break;
					before = undefined;
				}
			}
			before ??= input.beforeActive;
			const index = before ? input.container.children.indexOf(before) : -1;
			if (index < 0) input.container.addChild(component);
			else input.container.children.splice(index, 0, component);
		}
	}
}
