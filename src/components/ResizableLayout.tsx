import {
	type Component,
	createSignal,
	type JSX,
	onCleanup,
	Show,
} from "solid-js";

const STORAGE_KEY = "crust_pane_widths";

const MIN_SPACES = 48;
const MAX_SPACES = 96;
const MIN_ROOM_LIST = 180;
const MAX_ROOM_LIST = 480;
const MIN_MEMBERS = 200;
const MAX_MEMBERS = 400;
const DEFAULT_MEMBERS = 240;

interface PaneWidths {
	spaces: number;
	roomList: number;
	members: number;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function loadWidths(): PaneWidths {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw);
			if (
				typeof parsed.spaces === "number" &&
				typeof parsed.roomList === "number"
			) {
				return {
					spaces: clamp(parsed.spaces, MIN_SPACES, MAX_SPACES),
					roomList: clamp(parsed.roomList, MIN_ROOM_LIST, MAX_ROOM_LIST),
					members:
						typeof parsed.members === "number"
							? clamp(parsed.members, MIN_MEMBERS, MAX_MEMBERS)
							: DEFAULT_MEMBERS,
				};
			}
		}
	} catch {
		// ignore
	}
	return { spaces: 64, roomList: 256, members: DEFAULT_MEMBERS };
}

function saveWidths(widths: PaneWidths): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(widths));
	} catch {
		// Storage may be unavailable (private mode, quota exceeded)
	}
}

const STEP = 10;

const ResizeDivider: Component<{
	onDrag: (delta: number) => void;
	onDragEnd: () => void;
	value: number;
	min: number;
	max: number;
	label: string;
}> = (props) => {
	let dragging = false;
	let lastX = 0;

	const onMouseDown = (e: MouseEvent): void => {
		if (e.button !== 0 || dragging) return;
		e.preventDefault();
		dragging = true;
		lastX = e.clientX;
		document.addEventListener("mousemove", onMouseMove);
		document.addEventListener("mouseup", onMouseUp);
	};

	const onMouseMove = (e: MouseEvent): void => {
		if (!dragging) return;
		const delta = e.clientX - lastX;
		lastX = e.clientX;
		props.onDrag(delta);
	};

	const onMouseUp = (): void => {
		dragging = false;
		document.removeEventListener("mousemove", onMouseMove);
		document.removeEventListener("mouseup", onMouseUp);
		props.onDragEnd();
	};

	const onKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "ArrowRight" || e.key === "ArrowDown") {
			e.preventDefault();
			props.onDrag(STEP);
			props.onDragEnd();
		} else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
			e.preventDefault();
			props.onDrag(-STEP);
			props.onDragEnd();
		}
	};

	onCleanup(() => {
		document.removeEventListener("mousemove", onMouseMove);
		document.removeEventListener("mouseup", onMouseUp);
	});

	return (
		// biome-ignore lint/a11y/useSemanticElements: custom drag separator needs div for mouse handling
		<div
			class="w-1 shrink-0 cursor-col-resize bg-neutral-800 transition-colors hover:bg-pink-500 active:bg-pink-500"
			onMouseDown={onMouseDown}
			onKeyDown={onKeyDown}
			role="separator"
			aria-orientation="vertical"
			aria-valuenow={props.value}
			aria-valuemin={props.min}
			aria-valuemax={props.max}
			aria-label={props.label}
			tabIndex={0}
		/>
	);
};

export const ResizableLayout: Component<{
	spaces: JSX.Element;
	roomList: JSX.Element;
	main: JSX.Element;
	members?: JSX.Element;
	membersVisible?: boolean;
}> = (props) => {
	const initial = loadWidths();
	const [spacesWidth, setSpacesWidth] = createSignal(initial.spaces);
	const [roomListWidth, setRoomListWidth] = createSignal(initial.roomList);
	const [membersWidth, setMembersWidth] = createSignal(initial.members);

	const persist = (): void => {
		saveWidths({
			spaces: spacesWidth(),
			roomList: roomListWidth(),
			members: membersWidth(),
		});
	};

	return (
		<div class="flex min-h-0 flex-1">
			<div
				style={{ width: `${spacesWidth()}px` }}
				class="shrink-0 overflow-hidden"
			>
				{props.spaces}
			</div>
			<ResizeDivider
				onDrag={(d) =>
					setSpacesWidth((w) => clamp(w + d, MIN_SPACES, MAX_SPACES))
				}
				onDragEnd={persist}
				value={spacesWidth()}
				min={MIN_SPACES}
				max={MAX_SPACES}
				label="Resize spaces sidebar"
			/>
			<div
				style={{ width: `${roomListWidth()}px` }}
				class="shrink-0 overflow-hidden"
			>
				{props.roomList}
			</div>
			<ResizeDivider
				onDrag={(d) =>
					setRoomListWidth((w) => clamp(w + d, MIN_ROOM_LIST, MAX_ROOM_LIST))
				}
				onDragEnd={persist}
				value={roomListWidth()}
				min={MIN_ROOM_LIST}
				max={MAX_ROOM_LIST}
				label="Resize room list"
			/>
			<div class="min-w-0 flex-1">{props.main}</div>
			<Show when={props.membersVisible}>
				<ResizeDivider
					onDrag={(d) =>
						setMembersWidth((w) => clamp(w - d, MIN_MEMBERS, MAX_MEMBERS))
					}
					onDragEnd={persist}
					value={membersWidth()}
					min={MIN_MEMBERS}
					max={MAX_MEMBERS}
					label="Resize members panel"
				/>
				<div
					style={{ width: `${membersWidth()}px` }}
					class="shrink-0 overflow-hidden"
				>
					{props.members}
				</div>
			</Show>
		</div>
	);
};
