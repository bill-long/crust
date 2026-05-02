/**
 * Lightweight mock for matrix-js-sdk MatrixClient.
 * Only stubs the methods used by useTimeline and TimelineView.
 * Extend as needed for other test files.
 */

import { vi } from "vitest";

/** Minimal MatrixEvent-like object for testing. */
export interface MockEvent {
	eventId: string;
	roomId: string;
	sender: string;
	type: string;
	content: Record<string, unknown>;
	ts: number;
	encrypted?: boolean;
	decryptionFailure?: boolean;
	replacingEventId?: string;
}

function createMatrixEvent(evt: MockEvent) {
	return {
		getId: () => evt.eventId,
		getRoomId: () => evt.roomId,
		getSender: () => evt.sender,
		getType: () => evt.type,
		getContent: () => evt.content,
		getTs: () => evt.ts,
		isEncrypted: () => evt.encrypted ?? false,
		isDecryptionFailure: () => evt.decryptionFailure ?? false,
		replacingEventId: () => evt.replacingEventId ?? null,
		event: { redacts: undefined },
	};
}

export function createMockRoom(
	roomId: string,
	events: MockEvent[] = [],
	members: { userId: string; name: string }[] = [],
) {
	const matrixEvents = events.map(createMatrixEvent);
	return {
		roomId,
		getLiveTimeline: () => ({
			getEvents: () => matrixEvents,
		}),
		getUnfilteredTimelineSet: () => ({
			relations: {
				getChildEventsForEvent: () => null,
			},
		}),
		getEventReadUpTo: (_userId: string, _ignoreSynthesized?: boolean) =>
			null as string | null,
		getMember: (userId: string) => {
			const m = members.find((m) => m.userId === userId);
			return m ? { name: m.name, userId: m.userId, typing: false } : null;
		},
		getJoinedMembers: () =>
			members.map((m) => ({
				userId: m.userId,
				name: m.name,
				typing: false,
			})),
		getMembers: () =>
			members.map((m) => ({
				userId: m.userId,
				name: m.name,
				typing: false,
			})),
	};
}

export function createMockClient(
	rooms: Map<string, ReturnType<typeof createMockRoom>> = new Map(),
) {
	const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

	const client = {
		getUserId: () => "@test:example.com",
		getDeviceId: () => "TESTDEVICE",
		getRoom: (roomId: string) => rooms.get(roomId) ?? null,
		getVisibleRooms: () => Array.from(rooms.values()),
		mxcUrlToHttp: (
			mxcUrl: string,
			_w?: number,
			_h?: number,
			_method?: string,
		) =>
			mxcUrl.replace(
				"mxc://",
				"https://example.com/_matrix/media/v3/download/",
			),
		sendMessage: vi.fn().mockResolvedValue({ event_id: "$sent" }),
		sendEvent: vi.fn().mockResolvedValue({ event_id: "$sent" }),
		sendTyping: vi.fn().mockResolvedValue(undefined),
		sendReadReceipt: vi.fn().mockResolvedValue(undefined),
		redactEvent: vi.fn().mockResolvedValue(undefined),
		getAccountData: () => null,
		getHomeserverUrl: () => "https://example.com",
		on: (event: string, handler: (...args: unknown[]) => void) => {
			if (!listeners.has(event)) listeners.set(event, new Set());
			listeners.get(event)!.add(handler);
			return client;
		},
		off: (event: string, handler: (...args: unknown[]) => void) => {
			listeners.get(event)?.delete(handler);
			return client;
		},
		removeListener: (event: string, handler: (...args: unknown[]) => void) => {
			listeners.get(event)?.delete(handler);
			return client;
		},

		// Test helper: emit an event to registered listeners
		__emit: (event: string, ...args: unknown[]) => {
			const handlers = listeners.get(event);
			if (handlers) {
				for (const handler of handlers) handler(...args);
			}
		},

		// Test helper: update the rooms map
		__setRooms: (newRooms: Map<string, ReturnType<typeof createMockRoom>>) => {
			rooms = newRooms;
			// Update getRoom/getVisibleRooms closures
			client.getRoom = (roomId: string) => rooms.get(roomId) ?? null;
			client.getVisibleRooms = () => Array.from(rooms.values());
		},
	};

	return client;
}

/** Helper: create a simple text message event */
export function textMessage(
	roomId: string,
	eventId: string,
	sender: string,
	body: string,
	ts = Date.now(),
): MockEvent {
	return {
		eventId,
		roomId,
		sender,
		type: "m.room.message",
		content: { msgtype: "m.text", body },
		ts,
	};
}

/** Helper: create an encrypted event */
export function encryptedMessage(
	roomId: string,
	eventId: string,
	sender: string,
	ts = Date.now(),
	decryptionFailure = false,
): MockEvent {
	return {
		eventId,
		roomId,
		sender,
		type: decryptionFailure ? "m.room.encrypted" : "m.room.message",
		content: decryptionFailure
			? {}
			: { msgtype: "m.text", body: "decrypted text" },
		ts,
		encrypted: true,
		decryptionFailure,
	};
}
