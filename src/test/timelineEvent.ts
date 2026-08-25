import type { TimelineEvent } from "../features/room/timeline/timelineTypes";

/**
 * Fully-populated TimelineEvent for component tests, defaulting to a
 * plain confirmed text message. Shared by the TimelineItem suites so the
 * projection shape lives in one factory.
 */
export function makeTimelineEvent(
	overrides: Partial<TimelineEvent> = {},
): TimelineEvent {
	return {
		eventId: "$ev",
		senderId: "@mallory:example.com",
		senderName: "Mallory",
		timestamp: 1000,
		type: "m.room.message",
		msgtype: "m.text",
		body: "spam you should not see",
		format: null,
		formattedBody: null,
		mediaUrl: null,
		mediaWidth: null,
		mediaHeight: null,
		mediaFullUrl: null,
		mediaPosterUrl: null,
		mediaMimetype: null,
		mediaSize: null,
		mediaFilename: null,
		mediaCaption: null,
		mediaThumbnailUrl: null,
		mediaThumbnailFile: null,
		mediaThumbnailMimetype: null,
		mediaIsEncrypted: false,
		mediaEncryptedFile: null,
		isVoice: false,
		voiceDurationMs: null,
		voiceWaveform: null,
		isEncrypted: false,
		isDecryptionFailure: false,
		isEdited: false,
		replyToId: null,
		replyToSender: null,
		replyToBody: null,
		replyToThumbUrl: null,
		replyToThumbEncryptedFile: null,
		replyToThumbMimetype: null,
		reactions: {},
		myReactions: {},
		status: null,
		stateNotice: null,
		membershipTransition: null,
		poll: null,
		thread: null,
		...overrides,
	};
}
