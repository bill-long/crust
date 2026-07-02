/**
 * Single choke point for matrix-js-sdk's extensible-event poll classes.
 *
 * The classes are NOT re-exported from the "matrix-js-sdk" package root
 * (matrix.ts re-exports `@types/polls` and `models/poll`, but not
 * `extensible_events_v1/*`), so they must be deep-imported. The package
 * ships no `exports` map today, which makes these paths reachable - but an
 * SDK upgrade could change that, so every deep import lives here and
 * nowhere else. Fallback if that happens: hand-roll the small MSC3381 wire
 * payloads these serializers produce (see the factories in
 * src/test/mockClient.ts for the exact shapes).
 *
 * `.serialize()` on these classes emits the UNSTABLE event types
 * (org.matrix.msc3381.*), matching what Element puts on the wire.
 */
import type {
	ISendEventResponse,
	MatrixClient,
	TimelineEvents,
} from "matrix-js-sdk";

export { PollEndEvent } from "matrix-js-sdk/lib/extensible_events_v1/PollEndEvent";
export { PollResponseEvent } from "matrix-js-sdk/lib/extensible_events_v1/PollResponseEvent";

/**
 * Send a serialized extensible poll event. `client.sendEvent`'s typing is
 * keyed to the SDK's known-timeline-event map, which has no entries for the
 * unstable MSC3381 types the serializers emit; the runtime accepts any type
 * string, so the cast is confined to this one helper.
 */
export function sendSerializedPollEvent(
	client: MatrixClient,
	roomId: string,
	event: { serialize(): { type: string; content: object } },
): Promise<ISendEventResponse> {
	const { type, content } = event.serialize();
	return client.sendEvent(
		roomId,
		type as keyof TimelineEvents,
		content as TimelineEvents[keyof TimelineEvents],
	);
}
