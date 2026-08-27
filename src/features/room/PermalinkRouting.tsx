import { useLocation, useNavigate } from "@solidjs/router";
import type { MatrixClient } from "matrix-js-sdk";
import { type Component, onCleanup, onMount } from "solid-js";
import { basePrefix, stripBasePath } from "../../app/basePath";
import { safeDecode, useDecodedParams } from "../../app/useDecodedParams";
import { useClient } from "../../client/client";
import { parseMatrixUri } from "../../lib/matrixUri";
import { roomRoutePath } from "../../lib/roomRoute";
import { requestJoinDialog } from "../../stores/joinDialog";
import { openProfileCard } from "./profile/profileCard";

/**
 * Resolve a room ID or alias to the ID of a room the user has JOINED, or
 * `null` when the room is unknown or the membership is anything else
 * (invite/leave/ban) - those route to the join dialog instead.
 *
 * Aliases can't be looked up directly (`client.getRoom` takes IDs only), so
 * they are matched against every known room's canonical + alt aliases.
 */
export function findJoinedRoomId(
	client: MatrixClient,
	idOrAlias: string,
): string | null {
	if (idOrAlias.startsWith("!")) {
		const room = client.getRoom(idOrAlias);
		return room?.getMyMembership() === "join" ? room.roomId : null;
	}
	for (const room of client.getRooms()) {
		if (room.getMyMembership() !== "join") continue;
		if (
			room.getCanonicalAlias() === idOrAlias ||
			room.getAltAliases().includes(idOrAlias)
		) {
			return room.roomId;
		}
	}
	return null;
}

/**
 * In-app routing for Matrix permalinks (issue #441).
 *
 * Message bodies render matrix.to / matrix: links as ordinary external
 * anchors (`target="_blank"`). This component installs ONE document-level
 * click listener (rendered once by `Layout`, covering the timeline, thread
 * panel, pinned panel, and search results alike) that intercepts unmodified
 * left-clicks on those anchors and routes them inside the app:
 *
 *   - room link to a joined room   -> navigate to the room route
 *   - event permalink              -> navigate + `?event=` deep link, which
 *                                     RoomPane turns into a timeline jump
 *   - room link to an unknown room -> join-room dialog, prefilled
 *   - user link                    -> profile card anchored to the pill
 *                                     (#444; Open DM lives on the card)
 *
 * Anything that isn't a Matrix permalink, and clicks with modifiers or
 * non-left buttons, fall through to the anchor's default external-open
 * behavior.
 */
const PermalinkRouting: Component = () => {
	const { client, summaries } = useClient();
	const navigate = useNavigate();
	const location = useLocation();

	/** Route for a joined room, shared with global search so the two cannot
	 *  disagree about where a room lives - see `lib/roomRoute`. */
	const roomPath = (roomId: string): string => {
		const spaceMatch = /^\/space\/([^/]+)/.exec(
			stripBasePath(location.pathname, basePrefix),
		);
		return roomRoutePath(
			summaries,
			roomId,
			// `safeDecode`: this parses the path by hand, and a stray `%` in
			// the address bar would otherwise throw a URIError out of a
			// document-level click handler.
			spaceMatch ? safeDecode(spaceMatch[1]) : undefined,
		);
	};

	// Room the user is currently viewing (null on non-room routes), from
	// the router's own matched params rather than a re-parse of the path -
	// safeDecode included. Gives a pill's profile card its role/moderation
	// context and Mention target.
	const params = useDecodedParams<{ roomId?: string }>();

	const onDocumentClick = (e: MouseEvent): void => {
		if (e.defaultPrevented) return;
		// Modified clicks and non-left buttons keep the browser semantics
		// (open matrix.to in a new tab / window).
		if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
			return;
		const anchor =
			e.target instanceof Element ? e.target.closest("a[href]") : null;
		if (!anchor) return;
		const href = anchor.getAttribute("href");
		if (!href) return;
		const target = parseMatrixUri(href);
		if (!target) return;
		// It's a Matrix permalink - suppress the external open and route it.
		e.preventDefault();

		if (target.kind === "user") {
			// A user pill opens the profile card anchored to the pill (#444)
			// - including the user's own pill. Open DM lives on the card. A
			// pill inside the thread panel targets that thread's composer for
			// Mention (the panel marks its subtree with data-thread-root).
			openProfileCard({
				userId: target.userId,
				roomId: params.roomId ?? null,
				threadRootId:
					anchor
						.closest("[data-thread-root]")
						?.getAttribute("data-thread-root") ?? null,
				anchor: anchor as HTMLElement,
			});
			return;
		}

		const idOrAlias =
			target.kind === "event" ? target.roomIdOrAlias : target.idOrAlias;
		const roomId = findJoinedRoomId(client, idOrAlias);
		if (!roomId) {
			requestJoinDialog({
				idOrAlias,
				viaServers: target.viaServers,
			});
			return;
		}
		const path = roomPath(roomId);
		if (target.kind === "event") {
			navigate(`${path}?event=${encodeURIComponent(target.eventId)}`);
		} else {
			navigate(path);
		}
	};

	onMount(() => {
		document.addEventListener("click", onDocumentClick);
	});
	onCleanup(() => {
		document.removeEventListener("click", onDocumentClick);
	});

	return null;
};

export { PermalinkRouting };
