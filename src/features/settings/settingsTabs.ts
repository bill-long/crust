/**
 * Settings tab registry — extracted from SettingsOverlay.tsx so Layout.tsx
 * can resolve the active tab from the URL without statically importing the
 * overlay component module. SettingsOverlay.tsx is lazy-loaded (#307); a
 * static import of this value from that module would fold it (and its tab
 * subtrees) back into the entry chunk.
 */
export const tabMeta = [
	{ id: "general", label: "General" },
	{ id: "account", label: "Account" },
	{ id: "notifications", label: "Notifications" },
	{ id: "devices", label: "Devices & Security" },
] as const;

export type SettingsTab = (typeof tabMeta)[number]["id"];
