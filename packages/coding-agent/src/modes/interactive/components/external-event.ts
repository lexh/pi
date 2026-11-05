import { Box, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { ExternalEventCard } from "../../../core/external-event-projection.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

export class ExternalEventComponent extends Container {
	private card: ExternalEventCard;
	private expanded = false;
	private outputPad: number;

	constructor(card: ExternalEventCard, outputPad = 1) {
		super();
		this.card = card;
		this.outputPad = outputPad;
		this.rebuild();
	}

	setCard(card: ExternalEventCard): void {
		this.card = card;
		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.rebuild();
	}

	setOutputPad(outputPad: number): void {
		if (this.outputPad === outputPad) return;
		this.outputPad = outputPad;
		this.rebuild();
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		this.addChild(new Spacer(1));
		const box = new Box(this.outputPad, 1, (text) => theme.bg("customMessageBg", text));
		const card = this.card;
		const verified = card.verified ? "verified" : "unverified";
		box.addChild(
			new Text(
				theme.fg(
					"customMessageLabel",
					`[external ${card.state}, ${verified}] ${card.record.recipientIdentity} / ${card.record.eventId}`,
				),
				0,
				0,
			),
		);
		if (card.reason) box.addChild(new Text(theme.fg("dim", card.reason), 0, 0));
		if (this.expanded) {
			const origin =
				card.record.kind === "inherited"
					? card.record.origin
					: card.record.kind === "admission"
						? card.record
						: undefined;
			box.addChild(
				new Text(
					theme.fg(
						"dim",
						`source: ${card.sourceEntryId}${origin ? ` | request: ${origin.requestId}` : ""}${card.record.kind === "inherited" ? ` | origin session: ${card.record.origin.sessionId}` : ""}`,
					),
					0,
					0,
				),
			);
			box.addChild(new Text(theme.fg("dim", `provenance: ${JSON.stringify(card.record.provenance)}`), 0, 0));
			box.addChild(new Spacer(1));
			box.addChild(new Markdown(card.record.envelope, 0, 0, getMarkdownTheme()));
		} else if (card.state === "pending" || card.state === "unverified") {
			box.addChild(new Text(theme.fg("dim", card.record.envelope.slice(0, 160)), 0, 0));
		}
		this.addChild(box);
	}
}
