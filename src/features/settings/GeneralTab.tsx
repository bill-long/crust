import type { Component } from "solid-js";
import { updateSetting, userSettings } from "../../stores/settings";
import { SectionHeading, ToggleRow } from "./SettingsControls";

const GeneralTab: Component = () => {
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
							value={userSettings().zoomLevel}
							onInput={(e) =>
								updateSetting("zoomLevel", Number(e.currentTarget.value))
							}
							class="h-1.5 w-32 cursor-pointer appearance-none rounded-full bg-surface-2 accent-accent"
							aria-label="Zoom level"
						/>
						<span class="w-12 text-right text-sm tabular-nums text-text-secondary">
							{userSettings().zoomLevel}%
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
					<div class="flex rounded-lg bg-surface-2 p-0.5">
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
						>
							24h
						</button>
					</div>
				</div>
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
			</section>
		</div>
	);
};

export { GeneralTab };
