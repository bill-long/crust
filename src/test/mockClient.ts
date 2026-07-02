/**
 * Lightweight mock for matrix-js-sdk MatrixClient.
 * Only stubs the methods used by useTimeline and TimelineView.
 * Extend as needed for other test files.
 */

import { type EventStatus, MatrixEvent as SdkMatrixEvent } from "matrix-js-sdk";
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
	/** SDK send status. null/undefined = server-confirmed (the default). */
	status?: EventStatus | null;
	/**
	 * Replacement (edit) event for this event. The real SDK exposes
	 * `replacingEvent()` returning a MatrixEvent; tests can attach a
	 * replacement here to exercise the edit-status guards.
	 */
	replacingEvent?: MockEvent;
	/**
	 * Target event ID for `m.room.redaction` events (the raw SDK keeps
	 * this on `event.event.redacts`). Tests use it to exercise the
	 * pending-redaction overlay code paths.
	 */
	redacts?: string;
	/**
	 * Local pending redaction event targeting this event. Mirrors the
	 * real SDK's `_localRedactionEvent` so `localRedactionEvent()`
	 * returns truthy while a delete is in flight.
	 */
	localRedaction?: MockEvent;
	/** True once the redaction is server-confirmed (sets `unsigned.redacted_because`). */
	redacted?: boolean;
	/**
	 * State key for state events (e.g. the affected mxid for
	 * `m.room.member`). Exposed via `getStateKey()` on the wrapped
	 * event so the timeline can derive notice text.
	 */
	stateKey?: string;
	/**
	 * Prior state-event content, exposed via `getPrevContent()`.
	 * Used by the state-notice helper to derive transition text
	 * (leave→join, etc.).
	 */
	prevContent?: Record<string, unknown>;
	/**
	 * Server-aggregated bundled relations (`unsigned["m.relations"]`),
	 * keyed by rel_type - e.g. the `m.thread` bundle on a thread root.
	 * Exposed via `getServerAggregatedRelation()`.
	 */
	serverAggregations?: Record<string, unknown>;
}

export function createMatrixEvent(evt: MockEvent) {
	// Mutable status so tests can simulate the SDK lifecycle
	// (SENDING -> SENT / NOT_SENT / CANCELLED) without re-creating
	// the wrapper.
	let status: EventStatus | null = evt.status ?? null;
	let eventId = evt.eventId;
	const wrapped = {
		getId: () => eventId,
		getRoomId: () => evt.roomId,
		getSender: () => evt.sender,
		getType: () => evt.type,
		/**
		 * Mirrors matrix-js-sdk: when a replacement event exists, return
		 * its `m.new_content` regardless of status. When the event is
		 * locally redacted, return `{}` (the SDK's behavior; consumers
		 * who care about pending vs confirmed redaction must read
		 * `localRedactionEvent()` instead of trying to recover the body).
		 * Tests for the edit-confirmation and pending-redaction guards
		 * rely on this so the projection layer is what must filter
		 * pending/failed edits and pending-locally-redacted events.
		 */
		getContent: () => {
			if (evt.localRedaction || evt.redacted) {
				return {};
			}
			if (evt.replacingEvent) {
				const newContent = evt.replacingEvent.content?.["m.new_content"];
				if (newContent && typeof newContent === "object") {
					return newContent as Record<string, unknown>;
				}
			}
			return evt.content;
		},
		/**
		 * Always returns the pre-edit content, ignoring any replacement.
		 * Mirrors the SDK: returns `{}` when locally redacted, since the
		 * SDK has no way to recover content from a locally-redacted event.
		 */
		getOriginalContent: () => (evt.localRedaction ? {} : evt.content),
		/** Mirrors SDK `localRedactionEvent()`: the pending redaction MatrixEvent, or null. */
		localRedactionEvent: () =>
			evt.localRedaction ? createMatrixEvent(evt.localRedaction) : null,
		/**
		 * Mirrors SDK: true whenever `unsigned.redacted_because` is set,
		 * which `markLocallyRedacted` does immediately for pending
		 * local redactions as well as on server confirmation. Tests
		 * distinguish via `localRedactionEvent()` (truthy for pending,
		 * null after `makeRedacted` runs on server confirm).
		 */
		isRedacted: () => evt.redacted === true || !!evt.localRedaction,
		getTs: () => evt.ts,
		isEncrypted: () => evt.encrypted ?? false,
		isDecryptionFailure: () => evt.decryptionFailure ?? false,
		replacingEventId: () =>
			evt.replacingEvent?.eventId ?? evt.replacingEventId ?? null,
		replacingEvent: () =>
			evt.replacingEvent ? createMatrixEvent(evt.replacingEvent) : null,
		event: { redacts: evt.redacts },
		getStateKey: () => evt.stateKey,
		getPrevContent: () => evt.prevContent ?? {},
		/**
		 * Mirrors SDK `isRelation(relType?)`: reads WIRE content (the mock's
		 * raw `evt.content` - unaffected by edits/redactions, like the real
		 * getWireContent), requires both rel_type and event_id, and returns
		 * false for state events (which cannot be thread/replace relations).
		 */
		/** Mirrors SDK: returns unsigned["m.relations"][relType]. */
		getServerAggregatedRelation: (relType: string): unknown =>
			evt.serverAggregations?.[relType],
		isRelation: (relType?: string): boolean => {
			if (evt.stateKey !== undefined) return false;
			const relation = evt.content?.["m.relates_to"] as
				| { rel_type?: string; event_id?: string }
				| undefined;
			return !!(
				relation?.rel_type &&
				relation.event_id &&
				(relType ? relation.rel_type === relType : true)
			);
		},
		get status() {
			return status;
		},
		/**
		 * Mirrors SDK `unstableExtensibleEvent`: the matrix-events-sdk parse
		 * of the event (used by the poll projection). Delegates to a real
		 * SDK MatrixEvent so the mock exercises the same parser as
		 * production. Deliberately NOT cached: the real getter caches but
		 * invalidates on redaction/edit/decryption (invalidateExtensibleEvent),
		 * and the mock has no mutation hooks to invalidate from - re-parsing
		 * `getContent()` on every access matches the real post-mutation
		 * behavior, which is what tests care about.
		 */
		get unstableExtensibleEvent() {
			return new SdkMatrixEvent({
				type: evt.type,
				content: wrapped.getContent(),
			}).unstableExtensibleEvent;
		},

		/** Test helper: update status (does not emit; caller drives emissions). */
		__setStatus: (next: EventStatus | null) => {
			status = next;
		},
		/** Test helper: rewrite the event ID (simulates local-echo rekey). */
		__setId: (next: string) => {
			eventId = next;
		},
	};
	return wrapped;
}

export function createMockRoom(
	roomId: string,
	events: MockEvent[] = [],
	members: {
		userId: string;
		name: string;
		typing?: boolean;
		membership?: string;
		powerLevel?: number;
		avatarUrl?: string;
	}[] = [],
	options?: { name?: string },
) {
	const matrixEvents = events.map(createMatrixEvent);
	// Mutable member state for typing simulation
	const memberState = members.map((m) => ({
		userId: m.userId,
		name: m.name,
		roomId,
		typing: m.typing ?? false,
		membership: m.membership ?? "join",
		powerLevel: m.powerLevel ?? 0,
		getMxcAvatarUrl: () => m.avatarUrl ?? undefined,
	}));
	// Configurable read receipt positions per user
	const readUpTo = new Map<string, string | null>();

	let baseIndex = 0;
	let backwardPaginationToken: string | null = null;
	let forwardPaginationToken: string | null = null;
	const timeline = {
		getEvents: () => matrixEvents,
		getPaginationToken: (direction?: unknown) =>
			direction === "f" /* Direction.Forward */
				? forwardPaginationToken
				: backwardPaginationToken,
		getBaseIndex: () => baseIndex,
		getNeighbouringTimeline: () => null,
		setNeighbouringTimeline: () => {},
		setPaginationToken: () => {},
		/** Test helper: prepend event with correct baseIndex tracking */
		__prepend: (event: ReturnType<typeof createMatrixEvent>) => {
			matrixEvents.unshift(event);
			baseIndex++;
		},
		/** Test helper: append event (simulates live event arriving on timeline) */
		__append: (event: ReturnType<typeof createMatrixEvent>) => {
			matrixEvents.push(event);
		},
	};

	const timelineSet = {
		room: null as unknown,
		getLiveTimeline: () => timeline,
		getTimelineForEvent: () => null,
		relations: {
			getChildEventsForEvent: () => null,
		},
	};

	// State events storage for currentState mock
	const stateEventStore = new Map<
		string,
		Map<
			string,
			{
				getContent: () => Record<string, unknown>;
				getStateKey: () => string;
				getType: () => string;
				getRoomId: () => string;
				getTs: () => number;
				getSender: () => string | null;
			}
		>
	>();

	const canSendStateByType = new Map<string, boolean>();
	let canInviteFlag = true;
	let isSpaceFlag = false;
	let isEncryptedFlag = false;
	let maySendRedactionFlag = false;
	const currentState = {
		getStateEvents: (type: string, stateKey?: string) => {
			const typeMap = stateEventStore.get(type);
			if (stateKey !== undefined) {
				return typeMap?.get(stateKey) ?? null;
			}
			return typeMap ? Array.from(typeMap.values()) : [];
		},
		maySendStateEvent: (type: string, _userId: string) =>
			canSendStateByType.has(type) ? !!canSendStateByType.get(type) : true,
		// Read by the SDK Poll model's validateEndEvent for non-creator
		// poll-end events.
		maySendRedactionForEvent: (_event: unknown, _userId: string) =>
			maySendRedactionFlag,
	};

	const roomListeners = new Map<string, Set<(...args: unknown[]) => void>>();
	/** Mirrors `Room.threads`: tests register Thread(-shaped) objects via
	 *  `room.threads.set(...)` and emit `ThreadEvent.*` on the room. */
	const threadsMap = new Map<string, unknown>();

	return {
		roomId,
		name: options?.name ?? roomId,
		currentState,
		/** SDK poll models keyed by poll (start event) id; tests insert real
		 *  `Poll` instances via `room.polls.set(...)` and emit
		 *  `PollEvent.New`. */
		polls: new Map<string, unknown>(),
		threads: threadsMap,
		getThread: (id: string): unknown => threadsMap.get(id) ?? null,
		getLiveTimeline: () => timeline,
		getUnfilteredTimelineSet: () => timelineSet,
		getEventReadUpTo: (userId: string, _ignoreSynthesized?: boolean) =>
			readUpTo.get(userId) ?? null,
		getMember: (userId: string) => {
			const m = memberState.find((m) => m.userId === userId);
			return m ?? null;
		},
		getJoinedMembers: () => memberState.filter((m) => m.membership === "join"),
		getMembers: () => [...memberState],
		canInvite: (_userId: string) => canInviteFlag,
		isSpaceRoom: () => isSpaceFlag,
		hasEncryptionStateEvent: () => isEncryptedFlag,
		findEventById: (eventId: string) =>
			matrixEvents.find((e) => e.getId() === eventId) ?? null,
		on: (event: string, handler: (...args: unknown[]) => void) => {
			if (!roomListeners.has(event)) roomListeners.set(event, new Set());
			roomListeners.get(event)?.add(handler);
		},
		off: (event: string, handler: (...args: unknown[]) => void) => {
			roomListeners.get(event)?.delete(handler);
		},
		removeListener: (event: string, handler: (...args: unknown[]) => void) => {
			roomListeners.get(event)?.delete(handler);
		},

		// Test helpers
		__emit: (event: string, ...args: unknown[]) => {
			const handlers = roomListeners.get(event);
			if (handlers) {
				for (const handler of handlers) handler(...args);
			}
		},
		__setCanSendStateEvent: (type: string, allowed: boolean) => {
			canSendStateByType.set(type, allowed);
		},
		__setCanInvite: (allowed: boolean) => {
			canInviteFlag = allowed;
		},
		__setIsSpace: (value: boolean) => {
			isSpaceFlag = value;
		},
		__setEncrypted: (value: boolean) => {
			isEncryptedFlag = value;
		},
		__setMaySendRedaction: (value: boolean) => {
			maySendRedactionFlag = value;
		},
		__setReadUpTo: (userId: string, eventId: string | null) => {
			readUpTo.set(userId, eventId);
		},
		__setTyping: (userId: string, typing: boolean) => {
			const m = memberState.find((m) => m.userId === userId);
			if (m) m.typing = typing;
		},
		__addMember: (member: {
			userId: string;
			name: string;
			typing?: boolean;
			membership?: string;
			powerLevel?: number;
			avatarUrl?: string;
		}) => {
			const existing = memberState.findIndex((m) => m.userId === member.userId);
			const entry = {
				userId: member.userId,
				name: member.name,
				roomId,
				typing: member.typing ?? false,
				membership: member.membership ?? "join",
				powerLevel: member.powerLevel ?? 0,
				getMxcAvatarUrl: () => member.avatarUrl ?? undefined,
			};
			if (existing >= 0) {
				memberState[existing] = entry;
			} else {
				memberState.push(entry);
			}
		},
		__setPaginationToken: (token: string | null, direction?: "b" | "f") => {
			if (direction === "f") {
				forwardPaginationToken = token;
			} else {
				backwardPaginationToken = token;
			}
		},
		__setStateEvent: (
			type: string,
			stateKey: string,
			content: Record<string, unknown> | null,
			options?: { ts?: number; sender?: string | null },
		) => {
			if (content === null) {
				stateEventStore.get(type)?.delete(stateKey);
				return;
			}
			if (!stateEventStore.has(type)) stateEventStore.set(type, new Map());
			const typeMap = stateEventStore.get(type);
			const ts = options?.ts ?? 0;
			const sender = options?.sender ?? null;
			typeMap?.set(stateKey, {
				getContent: () => content,
				getStateKey: () => stateKey,
				getType: () => type,
				getRoomId: () => roomId,
				getTs: () => ts,
				getSender: () => sender,
			});
		},
	};
}

export function createMockClient(
	rooms: Map<string, ReturnType<typeof createMockRoom>> = new Map(),
) {
	const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
	const accountData = new Map<
		string,
		{ getContent: () => Record<string, unknown>; getType: () => string }
	>();

	const client = {
		getUserId: () => "@test:example.com",
		getDeviceId: () => "TESTDEVICE",
		getRoom: (roomId: string) => rooms.get(roomId) ?? null,
		getVisibleRooms: () => Array.from(rooms.values()),
		getRooms: () => Array.from(rooms.values()),
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
		sendStateEvent: vi.fn().mockResolvedValue({ event_id: "$state" }),
		createRoom: vi.fn().mockResolvedValue({ room_id: "!created:example.com" }),
		getRoomDirectoryVisibility: vi
			.fn()
			.mockResolvedValue({ visibility: "private" }),
		setRoomDirectoryVisibility: vi.fn().mockResolvedValue({}),
		uploadContent: vi
			.fn()
			.mockResolvedValue({ content_uri: "mxc://example.com/avatar" }),
		getMediaConfig: vi.fn().mockResolvedValue({}),
		getDomain: () => "example.com",
		sendTyping: vi.fn().mockResolvedValue(undefined),
		sendReadReceipt: vi.fn().mockResolvedValue(undefined),
		redactEvent: vi.fn().mockResolvedValue(undefined),
		resendEvent: vi.fn().mockResolvedValue(undefined),
		cancelPendingEvent: vi.fn(),
		// Poll response fetching (SDK Poll.getResponses).
		relations: vi.fn().mockResolvedValue({ events: [], nextBatch: null }),
		decryptEventIfNeeded: vi.fn().mockResolvedValue(undefined),
		paginateEventTimeline: vi.fn().mockResolvedValue(false),
		getAccountData: (type: string) => accountData.get(type) ?? null,
		getHomeserverUrl: () => "https://example.com",
		on: (event: string, handler: (...args: unknown[]) => void) => {
			if (!listeners.has(event)) listeners.set(event, new Set());
			listeners.get(event)?.add(handler);
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
			client.getRooms = () => Array.from(rooms.values());
		},

		// Test helper: set or remove account data
		__setAccountData: (
			type: string,
			content: Record<string, unknown> | null,
		) => {
			if (content === null) {
				accountData.delete(type);
			} else {
				accountData.set(type, {
					getContent: () => content,
					getType: () => type,
				});
			}
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

/** A thread reply in the MSC3440 wire shape (fallback m.in_reply_to). */
export function threadReplyEvent(
	roomId: string,
	eventId: string,
	sender: string,
	rootId: string,
	body: string,
	ts = Date.now(),
): MockEvent {
	return {
		eventId,
		roomId,
		sender,
		type: "m.room.message",
		content: {
			msgtype: "m.text",
			body,
			"m.relates_to": {
				rel_type: "m.thread",
				event_id: rootId,
				is_falling_back: true,
				"m.in_reply_to": { event_id: rootId },
			},
		},
		ts,
	};
}

/**
 * Helper: MSC3381 poll-start wire content (unstable prefixes, matching what
 * Element and the SDK's `PollStartEvent.serialize()` put on the wire).
 */
export function pollStartContent(
	question: string,
	answers: { id: string; text: string }[],
	options?: { kind?: "disclosed" | "undisclosed"; maxSelections?: number },
): Record<string, unknown> {
	return {
		"org.matrix.msc3381.poll.start": {
			question: { "org.matrix.msc1767.text": question },
			kind: `org.matrix.msc3381.poll.${options?.kind ?? "disclosed"}`,
			max_selections: options?.maxSelections ?? 1,
			answers: answers.map((a) => ({
				id: a.id,
				"org.matrix.msc1767.text": a.text,
			})),
		},
		"org.matrix.msc1767.text": [
			question,
			...answers.map((a, i) => `${i + 1}. ${a.text}`),
		].join("\n"),
	};
}

/** Helper: create an `m.poll.start` event (unstable type). */
export function pollStartEvent(
	roomId: string,
	eventId: string,
	sender: string,
	question: string,
	answers: { id: string; text: string }[],
	options?: {
		kind?: "disclosed" | "undisclosed";
		maxSelections?: number;
		ts?: number;
	},
): MockEvent {
	return {
		eventId,
		roomId,
		sender,
		type: "org.matrix.msc3381.poll.start",
		content: pollStartContent(question, answers, options),
		ts: options?.ts ?? Date.now(),
	};
}

/** Helper: create an `m.poll.response` (vote) event. Empty `answers`
 *  produces a spoiled ballot (MSC3381 vote retraction). */
export function pollResponseEvent(
	roomId: string,
	eventId: string,
	sender: string,
	pollId: string,
	answers: string[],
	ts = Date.now(),
): MockEvent {
	return {
		eventId,
		roomId,
		sender,
		type: "org.matrix.msc3381.poll.response",
		content: {
			"m.relates_to": { rel_type: "m.reference", event_id: pollId },
			"org.matrix.msc3381.poll.response": {
				answers: answers.length > 0 ? answers : undefined,
			},
		},
		ts,
	};
}

/** Helper: create an `m.poll.end` event. */
export function pollEndEvent(
	roomId: string,
	eventId: string,
	sender: string,
	pollId: string,
	ts = Date.now(),
): MockEvent {
	return {
		eventId,
		roomId,
		sender,
		type: "org.matrix.msc3381.poll.end",
		content: {
			"m.relates_to": { rel_type: "m.reference", event_id: pollId },
			"org.matrix.msc3381.poll.end": {},
			"org.matrix.msc1767.text": "The poll has ended.",
		},
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
