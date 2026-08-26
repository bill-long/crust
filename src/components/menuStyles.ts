/**
 * Shared chrome for the compact 180px menu SURFACE (adopted by the
 * spaces-sidebar tile menu, the room-list row menu, the timeline item's
 * "More" menu, and the composer "+" menu). The ITEM classes below are
 * shared only where the geometry matches (spaces sidebar, room list);
 * menus with their own item geometry keep local classes deliberately -
 * the timeline's tone-parameterized items, the room-pane overflow's
 * larger touch rows, and the wider Content strings in
 * RoomNotificationMenu / MembersTab / RoomPane.
 */
export const menuContentClass =
	"portal-scale z-50 min-w-[180px] rounded-lg border border-border-subtle bg-surface-3 p-1 shadow-lg focus-visible:outline-hidden";

const menuItemBaseClass =
	"flex cursor-pointer items-center rounded px-3 py-2 text-sm transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-hidden";

export const menuItemClass = `${menuItemBaseClass} text-text-primary`;

/** `menuItemClass` with the destructive-action text color. */
export const menuItemDangerClass = `${menuItemBaseClass} text-danger-text`;

/**
 * Disabled-state variant for Kobalte menu items (Kobalte stamps
 * `data-disabled` on disabled items). Inert on enabled items, so append it
 * to any item that can disable rather than inventing per-menu styling.
 */
export const menuItemDisabledClass =
	"data-disabled:cursor-default data-disabled:text-text-disabled data-disabled:hover:bg-transparent";
