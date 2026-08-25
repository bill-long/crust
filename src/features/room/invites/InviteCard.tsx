import { type Component, Show } from "solid-js";
import { avatarInitial } from "../../../lib/avatar";
import { createImageFallback } from "../../../lib/imageFallback";
import type { InvitePending } from "./useInviteActions";

interface InviteCardProps {
	name: string;
	avatarUrl: string | null;
	isSpace: boolean;
	isDirect: boolean;
	inviterName: string | null;
	inviterId: string | null;
	reason: string | null;
	pending: () => InvitePending;
	error: () => string | null;
	onAccept: () => void;
	onDecline: () => void;
}

/**
 * The accept/decline card for a pending invite: avatar, room/space name, who
 * invited you (name + MXID), the optional invite reason, and the two actions
 * with inline pending/error state. Shared by the main-pane invite view
 * (`InvitePane`) and the space-invite panel in `RoomList`.
 */
const InviteCard: Component<InviteCardProps> = (props) => {
	const avatar = createImageFallback(() => props.avatarUrl);

	const what = (): string =>
		props.isSpace ? "space" : props.isDirect ? "direct message" : "room";

	return (
		<div class="flex w-full max-w-sm flex-col items-center gap-4 rounded-lg border border-border-subtle bg-surface-1 p-6 text-center">
			<Show
				when={!avatar.failed() && props.avatarUrl}
				fallback={
					<div class="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-surface-3 text-xl font-semibold text-text-secondary">
						{avatarInitial(props.name)}
					</div>
				}
			>
				{(url) => (
					<img
						ref={avatar.ref}
						src={url()}
						alt=""
						class="h-16 w-16 shrink-0 rounded-full object-cover"
						onError={avatar.onError}
						onLoad={avatar.onLoad}
					/>
				)}
			</Show>

			<div class="flex min-w-0 flex-col gap-1">
				<span class="truncate text-lg font-semibold text-text-emphasis">
					{props.name.trim() || "Unnamed room"}
				</span>
				<span class="text-sm text-text-secondary">
					<Show
						when={props.inviterName}
						fallback={<>You've been invited to this {what()}</>}
					>
						<span class="font-medium text-text-primary">
							{props.inviterName}
						</span>{" "}
						invited you to this {what()}
					</Show>
				</span>
				<Show when={props.inviterId && props.inviterId !== props.inviterName}>
					<span class="truncate text-xs text-text-muted">
						{props.inviterId}
					</span>
				</Show>
			</div>

			<Show when={props.reason}>
				<p class="w-full rounded border-l-2 border-border-default bg-surface-2 px-3 py-2 text-left text-sm text-text-secondary">
					{props.reason}
				</p>
			</Show>

			<div class="flex w-full items-center justify-center gap-2">
				<button
					type="button"
					onClick={props.onDecline}
					disabled={props.pending() !== null}
					aria-busy={props.pending() === "decline"}
					class="min-w-24 rounded px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
				>
					{props.pending() === "decline" ? "Declining…" : "Decline"}
				</button>
				<button
					type="button"
					onClick={props.onAccept}
					disabled={props.pending() !== null}
					aria-busy={props.pending() === "accept"}
					class="min-w-24 rounded bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent/90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
				>
					{props.pending() === "accept" ? "Accepting…" : "Accept"}
				</button>
			</div>

			<Show when={props.error()}>
				<p role="alert" class="text-sm text-danger-text">
					{props.error()}
				</p>
			</Show>
		</div>
	);
};

export { InviteCard };
