/**
 * Shared chrome for right-click context-menu surfaces (the spaces-sidebar
 * tile menu and the room-list row menu), so a theme tweak lands on every
 * menu at once. The mobile room-pane overflow menu deliberately keeps its
 * own larger touch geometry (min-h-11 rows, wider surface) and is not
 * covered by these.
 */
export const menuContentClass =
	"portal-scale z-50 min-w-[180px] rounded-lg border border-border-subtle bg-surface-3 p-1 shadow-lg focus-visible:outline-hidden";

export const menuItemClass =
	"flex cursor-pointer items-center rounded px-3 py-2 text-sm text-text-primary transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-hidden";

/** `menuItemClass` with the destructive-action text color. */
export const menuItemDangerClass =
	"flex cursor-pointer items-center rounded px-3 py-2 text-sm text-danger-text transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-hidden";
