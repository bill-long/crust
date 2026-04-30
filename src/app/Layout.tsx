import { useNavigate, useParams } from "@solidjs/router";
import { type Component, Show } from "solid-js";
import { useClient } from "../client/client";
import { ResizableLayout } from "../components/ResizableLayout";
import RoomList from "../features/room/RoomList";
import TimelineView from "../features/room/timeline/TimelineView";
import SpacesSidebar from "../features/space/SpacesSidebar";
import { clearSession } from "../stores/session";

const Layout: Component = () => {
	const { client, syncState } = useClient();
	const params = useParams<{ roomId?: string }>();
	const navigate = useNavigate();

	const handleLogout = async (): Promise<void> => {
		try {
			await client.logout(true);
		} catch {
			client.stopClient();
		}
		clearSession();
		navigate("/login", { replace: true });
	};

	const displayName = (): string => {
		const userId = client.getUserId();
		return userId ?? "User";
	};

	return (
		<div class="flex h-screen flex-col bg-neutral-950 text-white">
			{/* Top bar */}
			<header class="flex h-12 shrink-0 items-center justify-between border-b border-neutral-800 px-4">
				<span class="text-lg font-bold">Crust</span>
				<div class="flex items-center gap-3">
					<span class="text-sm text-neutral-400">{displayName()}</span>
					<span class="text-xs text-neutral-600">{syncState()}</span>
					<button
						type="button"
						onClick={handleLogout}
						class="rounded px-2 py-1 text-sm text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-white"
					>
						Log out
					</button>
				</div>
			</header>

			{/* Three-column resizable layout */}
			<ResizableLayout
				spaces={<SpacesSidebar />}
				roomList={<RoomList />}
				main={
					<Show
						when={params.roomId}
						fallback={
							<main class="flex flex-1 flex-col">
								<div class="flex flex-1 items-center justify-center">
									<p class="text-neutral-500">
										Select a room to start chatting
									</p>
								</div>
							</main>
						}
					>
						{(roomId) => <TimelineView roomId={roomId()} />}
					</Show>
				}
			/>
		</div>
	);
};

export default Layout;
