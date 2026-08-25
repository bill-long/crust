import { cleanup, render } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_registry: unknown, _id: string, component: unknown) =>
		component,
	$$context: (_registry: unknown, _id: string, context: unknown) => context,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

import { formatMarkdown } from "../../lib/markdown";
import { createMockClient } from "../../test/mockClient";
import { MessageBody } from "./MessageBody";
import type { ResolvedEmote } from "./types";

afterEach(cleanup);

const client = createMockClient() as unknown as MatrixClient;

/** Compose markdown then render it the way the timeline would, returning the
 *  rendered container so we can assert the HTML survives DOMPurify. */
function renderComposed(text: string) {
	const { body, formatted_body } = formatMarkdown(text);
	const { container } = render(() => (
		<MessageBody
			body={body}
			format={formatted_body ? "org.matrix.custom.html" : null}
			formattedBody={formatted_body}
			isEdited={false}
			client={client}
			shortcodeLookup={new Map()}
		/>
	));
	return container;
}

describe("MessageBody — Phase 6 markdown round-trip through DOMPurify", () => {
	it("strikethrough survives as <del>", () => {
		const c = renderComposed("~~gone~~");
		expect(c.querySelector("del")).not.toBeNull();
		expect(c.textContent).toContain("gone");
	});

	it("unordered list survives as <ul><li>", () => {
		const c = renderComposed("- one\n- two");
		expect(c.querySelectorAll("ul li").length).toBe(2);
	});

	it("ordered list keeps its start attribute", () => {
		const c = renderComposed("3. a\n4. b");
		expect(c.querySelector("ol")?.getAttribute("start")).toBe("3");
	});

	it("heading survives as <h2>", () => {
		const c = renderComposed("## Title");
		expect(c.querySelector("h2")?.textContent).toBe("Title");
	});

	it("markdown link survives as a safe anchor opening in a new tab", () => {
		const c = renderComposed("[site](https://example.com)");
		const a = c.querySelector("a");
		expect(a?.getAttribute("href")).toBe("https://example.com");
		expect(a?.getAttribute("target")).toBe("_blank");
	});

	it("blockquote survives", () => {
		const c = renderComposed("> quoted");
		expect(c.querySelector("blockquote")?.textContent).toContain("quoted");
	});
});

describe("MessageBody Matrix permalinks", () => {
	it("keeps matrix.to anchors clickable in-app (target=_blank fallback retained)", () => {
		const { container } = render(() => (
			<MessageBody
				body="x"
				format="org.matrix.custom.html"
				formattedBody='<a href="https://matrix.to/#/!room:example.org">room</a>'
				isEdited={false}
				client={client}
				shortcodeLookup={new Map()}
			/>
		));
		const a = container.querySelector("a");
		expect(a?.getAttribute("href")).toBe(
			"https://matrix.to/#/!room:example.org",
		);
		expect(a?.getAttribute("target")).toBe("_blank");
	});

	it("lets matrix: URIs survive sanitization so the click router can intercept them", () => {
		const { container } = render(() => (
			<MessageBody
				body="x"
				format="org.matrix.custom.html"
				formattedBody='<a href="matrix:u/alice:example.org">alice</a>'
				isEdited={false}
				client={client}
				shortcodeLookup={new Map()}
			/>
		));
		expect(container.querySelector("a")?.getAttribute("href")).toBe(
			"matrix:u/alice:example.org",
		);
	});
});

describe("MessageBody rich-reply fallback", () => {
	it("strips the <mx-reply> block so relation-driven reply context isn't duplicated", () => {
		// A rich reply's formatted_body carries the legacy in-band fallback. The
		// timeline now renders reply context from the m.in_reply_to relation, so
		// MessageBody must not also render the quoted block.
		const formattedBody =
			"<mx-reply><blockquote>" +
			'<a href="https://matrix.to/#/!r:hs/$e">In reply to</a> ' +
			'<a href="https://matrix.to/#/@bob:hs">@bob:hs</a>' +
			"<br>the quoted parent text</blockquote></mx-reply>" +
			"my actual reply";
		const { container } = render(() => (
			<MessageBody
				body="> <@bob:hs> the quoted parent text\n\nmy actual reply"
				format="org.matrix.custom.html"
				formattedBody={formattedBody}
				isEdited={false}
				client={client}
				shortcodeLookup={new Map()}
			/>
		));

		// The mx-reply node and its quoted text are gone; the reply body remains.
		expect(container.querySelector("mx-reply")).toBeNull();
		expect(container.textContent).not.toContain("the quoted parent text");
		expect(container.textContent).toContain("my actual reply");
	});

	it("leaves a user-authored blockquote (not a reply fallback) intact", () => {
		const formattedBody =
			"<blockquote>a genuine quote</blockquote><p>and a comment</p>";
		const { container } = render(() => (
			<MessageBody
				body="a genuine quote\nand a comment"
				format="org.matrix.custom.html"
				formattedBody={formattedBody}
				isEdited={false}
				client={client}
				shortcodeLookup={new Map()}
			/>
		));

		expect(container.querySelector("blockquote")).not.toBeNull();
		expect(container.textContent).toContain("a genuine quote");
	});
});

describe("MessageBody spoilers (MSC2010)", () => {
	function renderFormatted(formattedBody: string, body = "fallback") {
		const { container } = render(() => (
			<MessageBody
				body={body}
				format="org.matrix.custom.html"
				formattedBody={formattedBody}
				isEdited={false}
				client={client}
				shortcodeLookup={new Map()}
			/>
		));
		return container;
	}

	it("renders data-mx-spoiler as a hidden click-to-reveal control", () => {
		const c = renderFormatted("before <span data-mx-spoiler>secret</span>");
		const spoiler = c.querySelector(".spoiler");
		expect(spoiler).not.toBeNull();
		expect(spoiler?.getAttribute("role")).toBe("button");
		expect(spoiler?.getAttribute("tabindex")).toBe("0");
		expect(spoiler?.getAttribute("aria-expanded")).toBe("false");
		expect(spoiler?.getAttribute("aria-label")).toBe("Spoiler");
		const content = spoiler?.querySelector(".spoiler-content");
		expect(content?.getAttribute("aria-hidden")).toBe("true");
		expect(content?.textContent).toBe("secret");
	});

	it("carries the spoiler reason into the accessible label", () => {
		const c = renderFormatted(
			'<span data-mx-spoiler="movie ending">secret</span>',
		);
		const spoiler = c.querySelector(".spoiler");
		expect(spoiler?.getAttribute("aria-label")).toBe("Spoiler: movie ending");
	});

	it("reveals on click (one-way) and unhides the content", () => {
		const c = renderFormatted("<span data-mx-spoiler>secret</span>");
		const content = c.querySelector<HTMLElement>(".spoiler-content");
		content?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		const spoiler = c.querySelector(".spoiler");
		expect(spoiler?.classList.contains("revealed")).toBe(true);
		expect(spoiler?.getAttribute("aria-expanded")).toBe("true");
		expect(
			spoiler?.querySelector(".spoiler-content")?.getAttribute("aria-hidden"),
		).toBeNull();
	});

	it("reveals from the keyboard with Enter", () => {
		const c = renderFormatted("<span data-mx-spoiler>secret</span>");
		const spoiler = c.querySelector<HTMLElement>(".spoiler");
		spoiler?.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
		);
		expect(spoiler?.classList.contains("revealed")).toBe(true);
	});

	it("wraps a spoilered emoticon image in a reveal control", () => {
		const c = renderFormatted(
			'<img data-mx-emoticon data-mx-spoiler src="mxc://hs/abc" alt=":x:">',
		);
		const spoiler = c.querySelector(".spoiler");
		expect(spoiler?.getAttribute("role")).toBe("button");
		const img = spoiler?.querySelector(".spoiler-content img");
		expect(img).not.toBeNull();
	});

	it("keeps anchors inside hidden spoiler content out of the tab order until revealed", () => {
		const c = renderFormatted(
			'<span data-mx-spoiler>see <a href="https://example.com">link</a> and https://bare.example</span>',
		);
		const anchors = [...c.querySelectorAll(".spoiler-content a")];
		// The explicit anchor AND the one linkify created from the bare URL.
		expect(anchors.length).toBe(2);
		for (const a of anchors) {
			expect(a.getAttribute("tabindex")).toBe("-1");
		}
		c.querySelector<HTMLElement>(".spoiler-content")?.dispatchEvent(
			new MouseEvent("click", { bubbles: true }),
		);
		for (const a of c.querySelectorAll(".spoiler-content a")) {
			expect(a.getAttribute("tabindex")).toBeNull();
		}
	});

	it("keeps a revealed spoiler revealed when the html regenerates", () => {
		const [lookup, setLookup] = createSignal(new Map<string, ResolvedEmote>());
		const { container } = render(() => (
			<MessageBody
				body="fallback"
				format="org.matrix.custom.html"
				formattedBody="<span data-mx-spoiler>secret</span>"
				isEdited={false}
				client={client}
				shortcodeLookup={lookup()}
			/>
		));
		container
			.querySelector<HTMLElement>(".spoiler-content")
			?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(
			container.querySelector(".spoiler")?.classList.contains("revealed"),
		).toBe(true);
		// New Map identity (image packs finishing their load) regenerates
		// the innerHTML; the reveal must survive.
		setLookup(new Map());
		const spoiler = container.querySelector(".spoiler");
		expect(spoiler?.classList.contains("revealed")).toBe(true);
		expect(spoiler?.getAttribute("aria-expanded")).toBe("true");
	});

	it("keeps a nested spoiler hidden when only the outer one is revealed", () => {
		const c = renderFormatted(
			"<span data-mx-spoiler>outer <span data-mx-spoiler>inner " +
				'<a href="https://hidden.example">link</a></span></span>',
		);
		const outer = c.querySelector<HTMLElement>(".spoiler");
		outer
			?.querySelector(":scope > .spoiler-content")
			?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(outer?.classList.contains("revealed")).toBe(true);
		// The inner spoiler element (not outer's own content - a plain
		// descendant selector would match that first).
		const innerSpoiler = c.querySelectorAll(".spoiler")[1];
		const inner = innerSpoiler?.querySelector(":scope > .spoiler-content");
		expect(inner?.getAttribute("aria-hidden")).toBe("true");
		expect(inner?.querySelector("a")?.getAttribute("tabindex")).toBe("-1");
	});

	it("resets reveal state when the message content changes (edit)", () => {
		const [body, setBody] = createSignal(
			"<span data-mx-spoiler>one</span> x <span data-mx-spoiler>two</span>",
		);
		const { container } = render(() => (
			<MessageBody
				body="fallback"
				format="org.matrix.custom.html"
				formattedBody={body()}
				isEdited={false}
				client={client}
				shortcodeLookup={new Map()}
			/>
		));
		container
			.querySelector<HTMLElement>(".spoiler-content")
			?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(container.querySelectorAll(".spoiler.revealed").length).toBe(1);
		// An edit reorders the spoilers; positional idx keys are now
		// meaningless, so nothing may stay (or become) revealed.
		setBody(
			"<span data-mx-spoiler>NEW</span> y <span data-mx-spoiler>one</span>",
		);
		expect(container.querySelectorAll(".spoiler.revealed").length).toBe(0);
	});

	it("wraps a spoilered anchor so the control carries no href", () => {
		const c = renderFormatted(
			'<a data-mx-spoiler href="https://leak.example/x">hint</a>',
		);
		const spoiler = c.querySelector(".spoiler");
		expect(spoiler?.tagName).toBe("SPAN");
		expect(spoiler?.getAttribute("href")).toBeNull();
		const a = spoiler?.querySelector(".spoiler-content a");
		expect(a?.getAttribute("tabindex")).toBe("-1");
	});

	it("round-trips the composer's ||...|| markdown into a spoiler control", () => {
		const c = renderComposed("the killer is ||the butler||");
		const spoiler = c.querySelector(".spoiler");
		expect(spoiler).not.toBeNull();
		expect(spoiler?.querySelector(".spoiler-content")?.textContent).toBe(
			"the butler",
		);
	});
});
