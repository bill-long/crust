import { type Component, For, Show } from "solid-js";
import { formatBytes } from "../../../lib/formatBytes";
import { sanitizeFilename } from "./media/filename";
import type { PendingAttachment } from "./media/types";

function kindIcon(kind: PendingAttachment["kind"]): string {
	switch (kind) {
		case "video":
			return "🎬";
		case "audio":
			return "🔊";
		case "file":
			return "📎";
		default:
			return "🖼️";
	}
}

/**
 * Preview row(s) for files queued in the composer but not yet sent. Shows a
 * thumbnail/icon, name + size, an optional caption field, upload progress, and
 * a remove control. Rendered only when attachments are present.
 */
const AttachmentTray: Component<{
	attachments: PendingAttachment[];
	onRemove: (id: string) => void;
	onCaptionChange: (id: string, caption: string) => void;
}> = (props) => {
	return (
		<div class="mb-2 flex flex-col gap-2">
			<For each={props.attachments}>
				{(att) => {
					// att is a store row: reading its fields (att.caption, att.progress,
					// …) subscribes to just that field, and updateAttachment mutates in
					// place so the object reference is stable. That keeps <For> from
					// remounting the row on a caption keystroke or a progress tick, which
					// is what preserves the caption input's focus while typing.
					const uploading = (): boolean => att.status === "uploading";
					// The store never patches a row's `file`, so the display name is
					// fixed for this row's lifetime - compute it once.
					const name = sanitizeFilename(att.file.name);
					return (
						<div class="flex items-start gap-3 rounded bg-surface-2/50 p-2">
							<div class="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded bg-surface-3">
								<Show
									when={att.previewUrl}
									fallback={
										<span class="text-2xl" aria-hidden="true">
											{kindIcon(att.kind)}
										</span>
									}
								>
									{(url) => (
										<img
											src={url()}
											alt=""
											class="h-full w-full object-cover"
										/>
									)}
								</Show>
							</div>
							<div class="min-w-0 flex-1">
								<div class="flex items-center gap-2">
									<p class="min-w-0 flex-1 truncate text-xs text-text-secondary">
										{name}
									</p>
									<span class="shrink-0 text-xs text-text-disabled">
										{formatBytes(att.file.size)}
									</span>
									<button
										type="button"
										class="shrink-0 rounded p-1 text-text-disabled transition-colors hover:bg-surface-3 hover:text-text-secondary disabled:opacity-40"
										onClick={() => props.onRemove(att.id)}
										disabled={uploading()}
										aria-label={`Remove ${name}`}
									>
										✕
									</button>
								</div>
								<input
									type="text"
									value={att.caption}
									onInput={(e) =>
										props.onCaptionChange(att.id, e.currentTarget.value)
									}
									placeholder="Add a caption…"
									disabled={uploading()}
									aria-label={`Caption for ${name}`}
									class="mt-1 w-full rounded bg-surface-2 px-2 py-1 text-xs text-text-emphasis placeholder:text-text-disabled focus:outline-none focus:ring-1 focus:ring-accent-hover disabled:opacity-60"
								/>
								<Show when={uploading()}>
									<div
										class="mt-1 h-1 w-full overflow-hidden rounded bg-surface-3"
										role="progressbar"
										aria-label={`Upload progress for ${name}`}
										aria-valuemin={0}
										aria-valuemax={100}
										aria-valuenow={Math.round(att.progress * 100)}
									>
										<div
											class="h-full bg-accent-hover transition-[width]"
											style={{ width: `${Math.round(att.progress * 100)}%` }}
										/>
									</div>
								</Show>
								<Show when={att.status === "error" && att.error}>
									<p class="mt-1 text-xs text-danger-text" role="alert">
										{att.error}
									</p>
								</Show>
							</div>
						</div>
					);
				}}
			</For>
		</div>
	);
};

export { AttachmentTray };
