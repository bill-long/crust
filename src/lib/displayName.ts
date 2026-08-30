import { hasLineBreaker } from "./controlChars";

/**
 * Longest display name worth rendering.
 *
 * `displayname` is server-controlled and unbounded on the wire - Synapse caps
 * it at 256 characters, a federated or self-hosted server need not, and
 * Conduwuity does not. Tested against the RAW string, before any trim or
 * scan, because the member list re-enters this for every member on every
 * membership and typing event.
 */
const MAX_NAME_LENGTH = 1024;

/**
 * Element's direction-override strip, inlined.
 *
 * This is `removeDirectionOverrideChars` from `matrix-js-sdk/lib/utils`,
 * verbatim: U+202D LRO and U+202E RLO, which override direction for the rest
 * of the paragraph. Copied rather than imported because `pushCopy` runs in
 * the service worker and pulls this module with it - importing anything from
 * `matrix-js-sdk/lib/utils` takes the SDK's whole util graph along, and
 * measured `dist/sw.js` at 168.9 kB against 25.6 kB without it.
 *
 * A two-character regex is a safe thing to copy, and the tests pin both
 * characters. `scripts/check-sw-size.mjs` fails the build if the service
 * worker grows back, so this cannot regress silently the way it did once.
 */
const DIRECTION_OVERRIDES = /[\u202D-\u202E]/g;

/**
 * Whether a name has at least one glyph that renders.
 *
 * An emptiness test, never a reject rule: it can only fire on a name with no
 * visible character anywhere, so its false-positive set is empty and a name
 * that merely *contains* an invisible character is kept in full.
 *
 * `removeHiddenChars` is the SDK's version of this and is narrower than it
 * sounds - it leaves U+3164 HANGUL FILLER intact (unhomoglyph maps it to
 * U+1160 rather than dropping it), plus U+2060, U+00AD, U+180B and the
 * variation selectors. A name of two Hangul fillers rendered a blank row, a
 * blank `avatarInitial`, and an aria-label reading "View profile of " with
 * nothing after it.
 *
 * This replaces `removeHiddenChars` rather than calling it, which is the one
 * place this module reimplements the SDK instead of delegating. That call is
 * an NFD normalize, a global regex replace and a full `unhomoglyph` table
 * walk, and `useMemberList` runs this for every joined member on every
 * rAF-coalesced typing event: measured at 2.00ms per rebuild against 0.15ms
 * for the regex alone, at 3000 members - an eighth of the 16ms interaction
 * budget spent answering "is this name empty". The surrounding code
 * (`partitionByPresence`, `mergeSorted`) is hand-tuned to avoid exactly this.
 *
 * Equivalence checked codepoint by codepoint against the SDK's own set:
 * U+2000-U+200F and the whitespace are `White_Space` or `Cf`, U+202A-U+202F
 * are `Cf`, U+0300-U+036F are `Mn`, U+FEFF, U+061C and U+2062-U+2063 are
 * `Cf`. Only U+2800 BRAILLE PATTERN BLANK is outside all of them - it is
 * category `So` - hence the explicit member. Ours is a superset from there,
 * catching the Hangul fillers and soft hyphens the SDK misses.
 *
 * Written as "find one visible character", never as an anchored star over the
 * invisible classes. That form backtracks exponentially - U+00AD is both `Cf`
 * and `Default_Ignorable`, so a run of them followed by one visible character
 * is `(?:A|A)*$` and the engine walks 2^n paths. Measured at 108ms for 24
 * soft hyphens and quadrupling every two more, which freezes the tab on a
 * name far inside MAX_NAME_LENGTH.
 */
const HAS_VISIBLE_GLYPH =
	/[^\p{Default_Ignorable_Code_Point}\p{White_Space}\p{Mn}\p{Me}\p{Cf}\u2800]/u;

/**
 * A display name to render, or `fallback` when the supplied one would say
 * less than the fallback does.
 *
 * Element's policy, extended only where Element's own rationale reaches
 * further than its code does. Both halves are reimplemented rather than
 * delegated, each for its own reason recorded below - the strip because
 * importing `matrix-js-sdk/lib/utils` pulls the SDK into the service worker
 * through `pushCopy`, and the emptiness test because it is too expensive for
 * the member list's hot path.
 *
 * 1. **Bounded** - see {@link MAX_NAME_LENGTH}.
 * 2. **U+202D LRO and U+202E RLO stripped**, Element's rule and only that.
 *    They override direction for the rest of the paragraph. The name
 *    survives; only the two formatting characters go.
 * 3. **Falls back when nothing renders** - see {@link HAS_VISIBLE_GLYPH},
 *    which is Element's emptiness test widened and made cheap enough for the
 *    member list's hot path.
 * 4. **Falls back on a control character**, or on one of the mandatory line
 *    breaks outside C0 - see {@link hasLineBreaker}. No name legitimately contains a
 *    NUL or a bare CR, so the false-positive set is empty. C0 is also the one
 *    invisible class the SDK does not normalize at all, so `A<NUL>dmin`
 *    collides with nothing and earns no suffix - and `String.trim` leaves it,
 *    so `avatarInitial` would paint an empty circle. It is what keeps a name
 *    intact in an `aria-label`, a `title`, a push body and the plain-text
 *    export transcript, sinks Element does not have.
 * 5. **Keeps everything else.** A name is never refused for merely containing
 *    a suspicious character.
 *
 * Falls back rather than truncating, everywhere. `calculateDisplayName`
 * appends its `(@user:server)` disambiguation to the END of a name, so any
 * cut removes exactly the signal that exposes an impersonation attempt.
 *
 * ## What this deliberately does not do
 *
 * It does not close impersonation. A filter cannot separate "invisible for a
 * good reason" from "invisible for a bad reason", because they are the same
 * characters: ZWJ joins Persian letters and every multi-part emoji, variation
 * selectors are in the emoji presentation of a great many names, the
 * Mongolian free variation selectors pick letter forms, the tag characters
 * spell out the Scotland flag. Barring any of them breaks real names, and
 * allowing them leaves `A<char>dmin` rendering as `Admin`. Cyrillic `A` is a
 * different character that renders identically and no character rule touches
 * it at all.
 *
 * Impersonation is answered by the MXID: the SDK appends `(@user:server)` to
 * a `RoomMember.name` that looks like an MXID, carries a bidi character its
 * pattern lists, or collides with another member after NFD, zero-width
 * stripping and unhomoglyph - and Crust renders the MXID beside the name on
 * the profile card, the member rows, the pending invite and knock lists, the
 * invite card and the kick/ban confirmation.
 *
 * Nor does it contain the bidi embeddings and isolates. Those leak the same
 * way an unterminated override does - per UAX #9 an unmatched initiator also
 * runs to the end of the paragraph - and the SDK's own pattern misses
 * U+2066-U+2069 entirely, so `Admin<LRI>` gets no suffix and collides with
 * nothing.
 *
 * `unicode-bidi: isolate` was tried as the containment and does not earn its
 * place here: every slot that renders a name in Crust is a block box holding
 * nothing else, and a block already establishes its own bidi paragraph, so
 * the property is a no-op there. The slots where an initiator genuinely
 * reorders neighbouring text are the ones that concatenate a name into a
 * longer STRING - the membership notices, `memberRowLabel`'s aria-label, the
 * kick/ban title, the push copy, the export transcript - and CSS cannot
 * reach inside a string. Closing this means widening the strip, which is a
 * deliberate step past Element and is tracked in #575 rather than taken
 * quietly here.
 */
export function displayNameOr(
	raw: string | null | undefined,
	fallback: string,
): string {
	if (!raw) return fallback;
	if (raw.length > MAX_NAME_LENGTH) return fallback;
	const name = raw.replace(DIRECTION_OVERRIDES, "").trim();
	if (!HAS_VISIBLE_GLYPH.test(name)) return fallback;
	if (hasLineBreaker(name)) return fallback;
	return name;
}
