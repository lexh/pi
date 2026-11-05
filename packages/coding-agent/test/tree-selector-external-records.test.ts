import { stripVTControlCharacters } from "node:util";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionEntry, SessionMessageEntry, SessionTreeNode } from "../src/core/session-manager.ts";
import { TreeSelectorComponent } from "../src/modes/interactive/components/tree-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { admission, canonical, savedFixture } from "./helpers/external-events.ts";

beforeAll(() => {
	initTheme("dark");
});

beforeEach(() => {
	// Ensure test isolation: keybindings are a global singleton
	setKeybindings(new KeybindingsManager());
});

// Helper to create a user message entry
function userMessage(id: string, parentId: string | null, content: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: { role: "user", content, timestamp: Date.now() },
	};
}

// Helper to build a tree from entries using parentId relationships
function buildTree(entries: Array<SessionEntry>): SessionTreeNode[] {
	if (entries.length === 0) return [];

	const nodes: SessionTreeNode[] = entries.map((entry) => ({
		entry,
		children: [],
	}));

	const byId = new Map<string, SessionTreeNode>();
	for (const node of nodes) {
		byId.set(node.entry.id, node);
	}

	const roots: SessionTreeNode[] = [];
	for (const node of nodes) {
		if (node.entry.parentId === null) {
			roots.push(node);
		} else {
			const parent = byId.get(node.entry.parentId);
			if (parent) {
				parent.children.push(node);
			}
		}
	}
	return roots;
}

describe("TreeSelectorComponent", () => {
	test("previews, searches and copies external records without exposing them in user-only mode", () => {
		const fixture = savedFixture();
		const { manager, root } = fixture;
		const event = canonical("event", "INSPECTABLE_EXTERNAL_BODY");
		const canonicalId = manager.appendEntryOnce(event, root).entryId;
		const admissionId = manager.appendEntryOnce(admission(event, root), root).entryId;
		manager.branch(admissionId);
		manager.appendCompaction("summarized admission", null, 100);
		expect(manager.buildContextEntries().some((entry) => entry.id === admissionId)).toBe(false);
		for (const [id, kind, body] of [
			[canonicalId, "canonical", "INSPECTABLE_EXTERNAL_BODY"],
			[admissionId, "admission", "ADMITTED_BODY_c9f2"],
		] as const) {
			const selector = new TreeSelectorComponent(
				manager.getTree(),
				root,
				24,
				() => {},
				() => {},
				undefined,
				id,
				"all",
			);
			const list = selector.getTreeList();
			expect(stripVTControlCharacters(list.render(200).join("\n"))).toContain(`[external ${kind}: event]`);
			let copied: string | undefined;
			selector.onCopy = (text) => {
				copied = text;
			};
			selector.handleInput("\x18");
			expect(copied).toContain(body);
			selector.handleInput(body);
			expect(list.getSelectedNode()?.entry.id).toBe(id);
			selector.handleInput("\x1b");
			selector.handleInput("\x15");
			expect(list.getSelectedNode()?.entry.id).not.toBe(id);
		}
		fixture.cleanup();
	});

	test("searches and copies inherited external history", () => {
		const inherited: SessionEntry = {
			type: "custom",
			id: "inherited",
			parentId: "user",
			timestamp: new Date().toISOString(),
			customType: "pi.external-history.v1",
			data: {
				...canonical("historic", "INHERITED_BODY"),
				kind: "inherited",
				origin: {
					sessionId: "source",
					entryId: "old",
					requestId: "request",
					instanceId: "instance",
					epoch: 0,
					branchAnchor: null,
				},
				copiedFrom: { sessionId: "source", entryId: "old" },
			},
		};
		const selector = new TreeSelectorComponent(
			buildTree([userMessage("user", null, "ordinary"), inherited]),
			"user",
			24,
			() => {},
			() => {},
			undefined,
			"inherited",
			"all",
		);
		expect(stripVTControlCharacters(selector.render(200).join("\n"))).toContain("[external inherited: historic]");
		let copied: string | undefined;
		selector.onCopy = (text) => {
			copied = text;
		};
		selector.handleInput("\x18");
		expect(copied).toContain("INHERITED_BODY");
		selector.handleInput("INHERITED_BODY");
		expect(selector.getTreeList().getSelectedNode()?.entry.id).toBe("inherited");
	});
});
