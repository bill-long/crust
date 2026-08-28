import DOMPurify from "dompurify";

/**
 * The Matrix-spec HTML subset Crust accepts from `formatted_body`
 * (org.matrix.custom.html), shared by the live message renderer
 * (`features/emoji/MessageBody.tsx`) and chat export (#530). A received
 * event's HTML is untrusted off the wire, so every surface that re-emits
 * it into a document must go through this one allowlist.
 */
export const MATRIX_HTML_ALLOWED_TAGS = [
	"font",
	"del",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"blockquote",
	"p",
	"a",
	"ul",
	"ol",
	"sup",
	"sub",
	"li",
	"b",
	"i",
	"u",
	"strong",
	"em",
	"strike",
	"s",
	"code",
	"hr",
	"br",
	"div",
	"table",
	"thead",
	"tbody",
	"tr",
	"th",
	"td",
	"caption",
	"pre",
	"span",
	"img",
	"details",
	"summary",
	"mx-reply",
];

export const MATRIX_HTML_ALLOWED_ATTR = [
	"data-mx-bg-color",
	"data-mx-color",
	"data-mx-emoticon",
	"data-mx-maths",
	"data-mx-spoiler",
	"color",
	"name",
	"target",
	"href",
	"src",
	"alt",
	"title",
	"width",
	"height",
	"data-mx-pill",
	"start",
	"colspan",
	"rowspan",
];

// Allow mxc:// scheme in URI attributes so DOMPurify doesn't strip img src,
// and matrix: so in-spec `matrix:u/...` permalinks survive to the click
// router (see PermalinkRouting, issue #441).
export const MATRIX_HTML_ALLOWED_URI_REGEXP =
	/^(?:(?:https?|mxc|mailto|tel|xmpp|geo|magnet|matrix):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

/**
 * Sanitize Matrix HTML into a detached container for further processing:
 * DOMPurify with the spec allowlist, the legacy `<mx-reply>` fallback
 * removed (the `m.in_reply_to` relation drives reply context everywhere
 * in Crust, so rendering the in-band quote too would double it), and a
 * strict image policy - only custom-emoticon images with `mxc://`
 * sources survive (everything else is a tracking-pixel risk), rewritten
 * to HTTP via `mxcToHttp` or removed when it declines.
 *
 * Callers run their own passes over the returned div (linkify, emoji,
 * spoiler controls, link targets) and serialize with `innerHTML`.
 */
export function sanitizeMatrixHtmlToDiv(
	html: string,
	mxcToHttp: (mxcUrl: string) => string | null,
): HTMLDivElement {
	const clean = DOMPurify.sanitize(html, {
		ALLOWED_TAGS: MATRIX_HTML_ALLOWED_TAGS,
		ALLOWED_ATTR: MATRIX_HTML_ALLOWED_ATTR,
		ALLOW_DATA_ATTR: false,
		ADD_ATTR: [
			"data-mx-emoticon",
			"data-mx-bg-color",
			"data-mx-color",
			"data-mx-pill",
			"data-mx-maths",
			"data-mx-spoiler",
		],
		ALLOWED_URI_REGEXP: MATRIX_HTML_ALLOWED_URI_REGEXP,
	});

	const div = document.createElement("div");
	div.innerHTML = clean;

	// Remove the whole legacy reply node (with its blockquote children),
	// not just the tag. Mirrors how the plain-text `> ` fallback is
	// stripped in `plainTextToHtml`.
	for (const reply of div.querySelectorAll("mx-reply")) {
		reply.remove();
	}

	// Process images: only keep data-mx-emoticon with mxc:// src (strip
	// tracking pixels).
	for (const img of div.querySelectorAll("img")) {
		const src = img.getAttribute("src");
		const isEmoticon = img.hasAttribute("data-mx-emoticon");
		if (!isEmoticon || !src?.startsWith("mxc://")) {
			img.remove();
			continue;
		}
		const httpUrl = mxcToHttp(src);
		if (httpUrl) {
			img.setAttribute("src", httpUrl);
		} else {
			img.remove();
		}
	}

	return div;
}
