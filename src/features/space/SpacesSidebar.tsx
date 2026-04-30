import { useNavigate, useParams } from "@solidjs/router";
import { type Component, createMemo, For, Show } from "solid-js";
import { useClient } from "../../client/client";
import {
	getSpaces,
	getSpaceUnreadRollup,
} from "../../client/summaries-selectors";

const SpacesSidebar: Component = () => {
	const { summaries } = useClient();
	const params = useParams<{ spaceId?: string }>();
	const navigate = useNavigate();

	const spaces = createMemo(() => getSpaces(summaries));

	return (
		<aside class="flex w-16 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-neutral-800 bg-neutral-900 py-3">
			{/* Home button */}
			<button
				type="button"
				onClick={() => navigate("/home")}
				class={`flex h-10 w-10 items-center justify-center rounded-2xl transition-all ${
					!params.spaceId
						? "rounded-xl bg-pink-600 text-white"
						: "bg-neutral-700 text-neutral-300 hover:rounded-xl hover:bg-neutral-600"
				}`}
				title="Home"
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

			<div class="mx-auto my-1 h-px w-8 bg-neutral-700" />

			{/* Space list */}
			<For each={spaces()}>
				{(space) => {
					const rollup = createMemo(() =>
						getSpaceUnreadRollup(summaries, space.roomId),
					);
					const isSelected = () => params.spaceId === space.roomId;

					return (
						<button
							type="button"
							onClick={() =>
								navigate(`/space/${encodeURIComponent(space.roomId)}`)
							}
							class={`relative flex h-10 w-10 items-center justify-center rounded-2xl transition-all ${
								isSelected()
									? "rounded-xl bg-pink-600 text-white"
									: "bg-neutral-700 text-neutral-300 hover:rounded-xl hover:bg-neutral-600"
							}`}
							title={space.name}
						>
							<Show
								when={space.avatarUrl}
								fallback={
									<span class="text-sm font-semibold">
										{space.name.charAt(0).toUpperCase()}
									</span>
								}
							>
								<img
									src={space.avatarUrl ?? ""}
									alt={space.name}
									class="h-10 w-10 rounded-2xl object-cover"
								/>
							</Show>

							{/* Unread badge */}
							<Show when={rollup().unread > 0}>
								<span
									class={`absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white ${
										rollup().highlight > 0 ? "bg-red-500" : "bg-neutral-500"
									}`}
								>
									{rollup().unread > 99 ? "99+" : rollup().unread}
								</span>
							</Show>
						</button>
					);
				}}
			</For>
		</aside>
	);
};

export default SpacesSidebar;
