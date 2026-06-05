import { ContextMenu } from "@kobalte/core/context-menu";
import { useNavigate } from "@solidjs/router";
import {
	type Accessor,
	type Component,
	createMemo,
	createSignal,
	For,
	type JSX,
	Show,
} from "solid-js";
import { useDecodedParams } from "../../app/useDecodedParams";
import { useClient } from "../../client/client";
import {
	getSpaces,
	getSpaceUnreadRollup,
} from "../../client/summaries-selectors";
import { CreateSpaceDialog } from "./CreateSpaceDialog";

interface SidebarItemProps {
	selected: Accessor<boolean>;
	children: JSX.Element;
}

const SidebarItem: Component<SidebarItemProps> = (props) => (
	<div class="relative flex justify-center">
		{props.children}
		<div
			class={`pointer-events-none absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-text-primary transition-all duration-150 ${
				props.selected() ? "h-10" : "h-0 peer-hover:h-5"
			}`}
		/>
	</div>
);

interface SpacesSidebarProps {
	/**
	 * Called when the user opens settings for a space via the hover/focus
	 * gear button on a space avatar or the right-click "Space settings"
	 * item.
	 */
	onOpenSpaceSettings?: (spaceId: string) => void;
	/**
	 * Called when the user picks the right-click "Leave space" item.
	 * Callers should open the leave confirmation flow.
	 */
	onLeaveSpace?: (spaceId: string) => void;
	/**
	 * Called when the user picks the right-click "Invite people" item.
	 * Only shown when the local user has permission to invite to the
	 * space. Callers should open the invite dialog targeting the space.
	 */
	onInviteSpace?: (spaceId: string) => void;
}

const SpacesSidebar: Component<SpacesSidebarProps> = (props) => {
	const { client, summaries } = useClient();
	const params = useDecodedParams<{ spaceId?: string }>();
	const navigate = useNavigate();
	const [createOpen, setCreateOpen] = createSignal(false);

	const spaces = createMemo(() => getSpaces(summaries));
	const homeSelected = () => !params.spaceId;
	const neverSelected = () => false;

	return (
		<aside class="flex h-full flex-col items-stretch bg-surface-1 py-3">
			{/* Top: scrolling list of Home + spaces. flex-1 + min-h-0 lets it
			    shrink below content height so the footer stays visible and
			    the inner list scrolls instead of pushing the footer off. */}
			<div class="flex min-h-0 flex-1 flex-col items-stretch gap-1 overflow-y-auto">
				{/* Home button */}
				<SidebarItem selected={homeSelected}>
					<button
						type="button"
						onClick={() => navigate("/home")}
						class={`peer flex h-10 w-10 items-center justify-center rounded-2xl transition-all ${
							homeSelected()
								? "rounded-xl bg-surface-2 text-text-primary"
								: "bg-surface-3 text-text-secondary hover:rounded-xl hover:bg-surface-4"
						}`}
						title="Home"
						aria-label="Home"
						aria-current={homeSelected() ? "page" : undefined}
					>
						<svg
							class="h-5 w-5"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
							stroke-width="2"
							aria-hidden="true"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0a1 1 0 01-1-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 01-1 1"
							/>
						</svg>
					</button>
				</SidebarItem>

				<div class="mx-auto my-1 h-px w-8 bg-surface-3" />

				{/* Space list */}
				<For each={spaces()}>
					{(space) => {
						const rollup = createMemo(() =>
							getSpaceUnreadRollup(summaries, space.roomId),
						);
						const isSelected = () => params.spaceId === space.roomId;
						// Render-time check: hide the Invite item when the local
						// user lacks invite permission in this space, or when the
						// space room isn't yet loaded into the SDK store. This
						// accepts mild staleness (no state-event subscription) —
						// the invite call itself will reject with M_FORBIDDEN if
						// permissions change after the menu opens.
						const canInviteToSpace = (): boolean => {
							if (!props.onInviteSpace) return false;
							const userId = client.getUserId();
							if (!userId) return false;
							const room = client.getRoom(space.roomId);
							return !!room?.canInvite(userId);
						};
						const hasMenu = (): boolean =>
							!!props.onOpenSpaceSettings ||
							!!props.onLeaveSpace ||
							canInviteToSpace();

						const triggerInner = (
							<>
								<button
									type="button"
									onClick={() =>
										navigate(`/space/${encodeURIComponent(space.roomId)}`)
									}
									class={`relative flex h-10 w-10 items-center justify-center rounded-2xl transition-all ${
										isSelected()
											? "rounded-xl bg-surface-2 text-text-primary"
											: "bg-surface-3 text-text-secondary hover:rounded-xl hover:bg-surface-4"
									}`}
									title={space.name.trim() || "Unnamed space"}
									aria-label={space.name.trim() || "Unnamed space"}
									aria-current={isSelected() ? "page" : undefined}
								>
									<Show
										when={space.avatarUrl}
										fallback={
											<span class="text-sm font-semibold">
												{(space.name.trim() || "?").charAt(0).toUpperCase()}
											</span>
										}
									>
										<img
											src={space.avatarUrl ?? ""}
											alt={space.name.trim() || "Space"}
											class="h-10 w-10 rounded-[inherit] object-cover transition-[border-radius]"
										/>
									</Show>

									{/* Unread badge */}
									<Show when={rollup().unread > 0}>
										<span
											class={`absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold text-text-primary ${
												rollup().highlight > 0 ? "bg-danger" : "bg-indicator"
											}`}
											role="status"
											aria-label={`${rollup().unread} unread${rollup().highlight > 0 ? `, ${rollup().highlight} highlighted` : ""}`}
										>
											{rollup().unread > 99 ? "99+" : rollup().unread}
										</span>
									</Show>
								</button>

								{/* Hover/focus-revealed gear → space settings. Sibling
								    of the avatar button (not nested) to avoid
								    nested-interactive HTML. Opacity is gated on
								    group-hover and focus-visible so keyboard users
								    can tab to it. */}
								<Show when={props.onOpenSpaceSettings}>
									<button
										type="button"
										onClick={() => props.onOpenSpaceSettings?.(space.roomId)}
										aria-label={`Settings for ${space.name.trim() || "Unnamed space"}`}
										title="Space settings"
										class="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full bg-surface-4 text-text-secondary pointer-events-none opacity-0 shadow transition-opacity hover:text-text-primary focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover group-hover:pointer-events-auto group-hover:opacity-100"
									>
										<svg
											aria-hidden="true"
											width="12"
											height="12"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											stroke-width="2.5"
											stroke-linecap="round"
											stroke-linejoin="round"
										>
											<circle cx="12" cy="12" r="2.5" />
											<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
										</svg>
									</button>
								</Show>
							</>
						);

						return (
							<SidebarItem selected={isSelected}>
								{/* Only mount the ContextMenu when at least one menu item
								    will render — otherwise right-clicking would open an
								    empty popover. When no handlers are wired, render the
								    avatar block in a plain wrapper that preserves the
								    `peer` + `group` hooks. */}
								<Show
									when={hasMenu()}
									fallback={
										<div class="peer group relative">{triggerInner}</div>
									}
								>
									<ContextMenu>
										<ContextMenu.Trigger class="peer group relative">
											{triggerInner}
										</ContextMenu.Trigger>

										<ContextMenu.Portal>
											<ContextMenu.Content class="z-50 min-w-[180px] rounded-lg border border-border-subtle bg-surface-3 p-1 shadow-lg focus-visible:outline-none">
												<Show when={props.onOpenSpaceSettings}>
													<ContextMenu.Item
														class="flex cursor-pointer items-center rounded px-3 py-2 text-sm text-text-primary transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
														onSelect={() =>
															props.onOpenSpaceSettings?.(space.roomId)
														}
													>
														Space settings
													</ContextMenu.Item>
												</Show>
												<Show when={canInviteToSpace()}>
													<ContextMenu.Item
														class="flex cursor-pointer items-center rounded px-3 py-2 text-sm text-text-primary transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
														onSelect={() => props.onInviteSpace?.(space.roomId)}
													>
														Invite people
													</ContextMenu.Item>
												</Show>
												<Show when={props.onLeaveSpace}>
													<ContextMenu.Item
														class="flex cursor-pointer items-center rounded px-3 py-2 text-sm text-danger-text transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none"
														onSelect={() => props.onLeaveSpace?.(space.roomId)}
													>
														Leave space
													</ContextMenu.Item>
												</Show>
											</ContextMenu.Content>
										</ContextMenu.Portal>
									</ContextMenu>
								</Show>
							</SidebarItem>
						);
					}}
				</For>
			</div>

			{/* Bottom: persistent Create-space button (always visible, never
			    scrolled out of view by a long space list). shrink-0 keeps
			    it from being squeezed by the scrolling list above. */}
			<div class="mt-1 flex shrink-0 flex-col items-stretch gap-1 pt-1">
				<div class="mx-auto h-px w-8 bg-surface-3" />
				<SidebarItem selected={neverSelected}>
					<button
						type="button"
						onClick={() => setCreateOpen(true)}
						class="peer flex h-10 w-10 items-center justify-center rounded-2xl bg-surface-3 text-success-text transition-all hover:rounded-xl hover:bg-success hover:text-accent-foreground"
						title="Create space"
						aria-label="Create space"
					>
						<svg
							class="h-5 w-5"
							fill="none"
							viewBox="0 0 24 24"
							stroke="currentColor"
							stroke-width="2.5"
							aria-hidden="true"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								d="M12 5v14M5 12h14"
							/>
						</svg>
					</button>
				</SidebarItem>
			</div>

			<CreateSpaceDialog
				client={client}
				open={createOpen}
				onClose={() => setCreateOpen(false)}
			/>
		</aside>
	);
};

export { SpacesSidebar };
