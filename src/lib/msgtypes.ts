/**
 * Msgtypes whose `body` is user-authored text. The single source for
 * every consumer that treats "a text message" as a category: forwarding
 * (rebuilt text content), room search, and the Copy text action.
 * Room-feature-neutral (search and timeline both consume it), hence lib.
 */
export const TEXT_MSGTYPES: ReadonlySet<string> = new Set([
	"m.text",
	"m.notice",
	"m.emote",
]);
