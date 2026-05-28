import {
	type Component,
	createEffect,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import { useClient } from "../../client/client";
import { updateSetting, userSettings } from "../../stores/settings";
import { pushLocalUrlPreviewSetting } from "../room/urlPreviews/accountDataSync";
import { SectionHeading, ToggleRow } from "./SettingsControls";

function MicDeviceSelect(): ReturnType<Component> {
	const [devices, setDevices] = createSignal<MediaDeviceInfo[]>([]);
	const [error, setError] = createSignal<string | null>(null);

	const refresh = async (): Promise<void> => {
		if (typeof navigator === "undefined" || !navigator.mediaDevices) {
			setError("MediaDevices API not available in this browser.");
			return;
		}
		try {
			const list = await navigator.mediaDevices.enumerateDevices();
			setDevices(list.filter((d) => d.kind === "audioinput"));
			setError(null);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const grantAccess = async (): Promise<void> => {
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			// We only needed the permission grant — release the tracks immediately.
			for (const track of stream.getTracks()) track.stop();
			await refresh();
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	onMount(() => {
		void refresh();
		if (typeof navigator !== "undefined" && navigator.mediaDevices) {
			const md = navigator.mediaDevices;
			const onChange = (): void => {
				void refresh();
			};
			md.addEventListener("devicechange", onChange);
			onCleanup(() => {
				md.removeEventListener("devicechange", onChange);
			});
		}
	});

	const labelsHidden = (): boolean =>
		devices().length > 0 && devices().every((d) => d.label === "");

	return (
		<div class="flex items-center justify-between gap-4 py-2">
			<div class="min-w-0 flex-1">
				<div class="text-sm font-medium text-text-primary">Microphone</div>
				<div class="text-xs text-text-muted">
					Input device used for native voice calls (preview).
				</div>
			</div>
			<div class="flex items-center gap-2">
				<Show when={labelsHidden()}>
					<button
						type="button"
						onClick={() => void grantAccess()}
						class="rounded bg-surface-2 px-2 py-1 text-xs text-text-secondary hover:bg-surface-3"
					>
						Grant access
					</button>
				</Show>
				<select
					value={userSettings().rtcMicDeviceId}
					onChange={(e) =>
						updateSetting("rtcMicDeviceId", e.currentTarget.value)
					}
					class="rounded bg-surface-2 px-2 py-1 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
					aria-label="Microphone device"
				>
					<option value="">System default</option>
					<For each={devices()}>
						{(d) => (
							<option value={d.deviceId}>
								{d.label || `Microphone (${d.deviceId.slice(0, 6)}…)`}
							</option>
						)}
					</For>
				</select>
			</div>
			<Show when={error()}>
				<div role="alert" class="text-xs text-danger-text">
					{error()}
				</div>
			</Show>
		</div>
	);
}

const GeneralTab: Component = () => {
	const { client } = useClient();
	// Local preview signal prevents a feedback loop: applying zoom resizes the
	// slider, which shifts the thumb to a higher value, which zooms further.
	// We show the preview number while dragging, but only apply zoom on release.
	const [zoomPreview, setZoomPreview] = createSignal(userSettings().zoomLevel);
	createEffect(() => setZoomPreview(userSettings().zoomLevel));

	return (
		<div class="space-y-8">
			{/* Appearance */}
			<section>
				<SectionHeading>Appearance</SectionHeading>
				<div class="flex items-center justify-between gap-4 py-2">
					<div class="min-w-0 flex-1">
						<div class="text-sm font-medium text-text-primary">Zoom Level</div>
						<div class="text-xs text-text-muted">
							Adjust the size of text and UI elements
						</div>
					</div>
					<div class="flex items-center gap-3">
						<input
							type="range"
							min="50"
							max="200"
							step="10"
							value={zoomPreview()}
							onInput={(e) => setZoomPreview(Number(e.currentTarget.value))}
							onChange={(e) =>
								updateSetting("zoomLevel", Number(e.currentTarget.value))
							}
							class="h-1.5 w-32 cursor-pointer appearance-none rounded-full bg-surface-2 accent-accent"
							aria-label="Zoom level"
						/>
						<span class="w-12 text-right text-sm tabular-nums text-text-secondary">
							{zoomPreview()}%
						</span>
					</div>
				</div>
			</section>

			{/* Date & Time */}
			<section>
				<SectionHeading>Date & Time</SectionHeading>
				<div class="flex items-center justify-between gap-4 py-2">
					<div class="min-w-0 flex-1">
						<div class="text-sm font-medium text-text-primary">Time Format</div>
						<div class="text-xs text-text-muted">
							Choose between 12-hour and 24-hour clock
						</div>
					</div>
					{/* biome-ignore lint/a11y/useSemanticElements: fieldset adds unwanted border/padding; flex layout prevents fieldset use */}
					<div
						class="flex rounded-lg bg-surface-2 p-0.5"
						role="group"
						aria-label="Time format"
					>
						<button
							type="button"
							onClick={() => updateSetting("timeFormat", "12h")}
							class="rounded-md px-3 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
							classList={{
								"bg-surface-3 text-text-primary font-medium":
									userSettings().timeFormat === "12h",
								"text-text-muted hover:text-text-secondary":
									userSettings().timeFormat !== "12h",
							}}
							aria-pressed={userSettings().timeFormat === "12h"}
						>
							12h
						</button>
						<button
							type="button"
							onClick={() => updateSetting("timeFormat", "24h")}
							class="rounded-md px-3 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
							classList={{
								"bg-surface-3 text-text-primary font-medium":
									userSettings().timeFormat === "24h",
								"text-text-muted hover:text-text-secondary":
									userSettings().timeFormat !== "24h",
							}}
							aria-pressed={userSettings().timeFormat === "24h"}
						>
							24h
						</button>
					</div>
				</div>
			</section>

			{/* Voice & Video */}
			<section>
				<SectionHeading>Voice & Video</SectionHeading>
				<MicDeviceSelect />
			</section>

			{/* Privacy */}
			<section>
				<SectionHeading>Privacy</SectionHeading>
				<ToggleRow
					label="Auto-load GIFs"
					description="Automatically download and display GIF images from external sources"
					checked={userSettings().autoDownloadGifs}
					onChange={(v) => updateSetting("autoDownloadGifs", v)}
				/>
				<ToggleRow
					label="Show link previews"
					description="Fetch link previews via your homeserver for messages containing URLs"
					checked={userSettings().urlPreviews}
					onChange={(v) => {
						updateSetting("urlPreviews", v);
						void pushLocalUrlPreviewSetting(client, v);
					}}
				/>
			</section>
		</div>
	);
};

export { GeneralTab };
