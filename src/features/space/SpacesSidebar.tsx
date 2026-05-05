import { useNavigate } from "@solidjs/router";
import {
	type Accessor,
	type Component,
	createMemo,
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

const SpacesSidebar: Component = () => {
	const { summaries } = useClient();
	const params = useDecodedParams<{ spaceId?: string }>();
	const navigate = useNavigate();

	const spaces = createMemo(() => getSpaces(summaries));
	const homeSelected = () => !params.spaceId;

	return (
		<aside class="flex h-full flex-col items-stretch gap-1 overflow-y-auto bg-surface-1 py-3">
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

					return (
						<SidebarItem selected={isSelected}>
							<button
								type="button"
								onClick={() =>
									navigate(`/space/${encodeURIComponent(space.roomId)}`)
								}
								class={`peer relative flex h-10 w-10 items-center justify-center rounded-2xl transition-all ${
									isSelected()
										? "rounded-xl bg-surface-2 text-text-primary"
										: "bg-surface-3 text-text-secondary hover:rounded-xl hover:bg-surface-4"
								}`}
								title={space.name.trim() || "Unnamed space"}
								aria-label={space.name.trim() || "Unnamed space"}
								aria-pressed={isSelected()}
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
						</SidebarItem>
					);
				}}
			</For>
		</aside>
	);
};

export { SpacesSidebar };
