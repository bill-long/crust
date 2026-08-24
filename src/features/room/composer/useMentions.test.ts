import type { MatrixClient, RoomMember } from "matrix-js-sdk";
import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_r: unknown, _i: string, c: unknown) => c,
	$$context: (_r: unknown, _i: string, c: unknown) => c,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

import { useMentions } from "./useMentions";

function makeMember(userId: string, name: string): RoomMember {
	return { userId, name } as RoomMember;
}

function setup(members: RoomMember[]) {
	const client = {
		getRoom: () => ({ getJoinedMembers: () => members }),
	} as unknown as MatrixClient;
	return createRoot((dispose) => {
		const mentions = useMentions({
			client,
			roomId: () => "!room:example.com",
			getTextarea: () => undefined,
			text: () => "",
			setText: () => {},
			autoResize: () => {},
		});
		return { mentions, dispose };
	});
}

describe("useMentions filteredMembers", () => {
	it("returns every match - no result cap (the picker windows its rows)", () => {
		const members = Array.from({ length: 120 }, (_, i) =>
			makeMember(`@user${i}:example.com`, `Member ${i}`),
		);
		const { mentions, dispose } = setup(members);
		try {
			mentions.setMentionQuery("member");
			expect(mentions.filteredMembers().length).toBe(120);
		} finally {
			dispose();
		}
	});

	it("matches by display name or user ID, case-insensitively", () => {
		const members = [
			makeMember("@alice:example.com", "Alice"),
			makeMember("@bob:example.com", "Bob"),
			makeMember("@carol:example.com", "carlisle"),
		];
		const { mentions, dispose } = setup(members);
		try {
			mentions.setMentionQuery("AL");
			expect(mentions.filteredMembers().map((m) => m.userId)).toEqual([
				"@alice:example.com",
			]);
			mentions.setMentionQuery("carol");
			// carlisle's name doesn't contain "carol" but the user ID does.
			expect(mentions.filteredMembers().map((m) => m.userId)).toEqual([
				"@carol:example.com",
			]);
		} finally {
			dispose();
		}
	});

	it("is empty when no mention is being typed (null query)", () => {
		const { mentions, dispose } = setup([
			makeMember("@alice:example.com", "Alice"),
		]);
		try {
			expect(mentions.filteredMembers()).toEqual([]);
		} finally {
			dispose();
		}
	});
});
