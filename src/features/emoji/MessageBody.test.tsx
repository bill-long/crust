import { cleanup, render } from "@solidjs/testing-library";
import type { MatrixClient } from "matrix-js-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("solid-refresh", () => ({
	$$registry: () => new Map(),
	$$component: (_registry: unknown, _id: string, component: unknown) =>
		component,
	$$context: (_registry: unknown, _id: string, context: unknown) => context,
	$$decline: () => undefined,
	$$refresh: () => undefined,
}));

import { createMockClient } from "../../test/mockClient";
import { formatMarkdown } from "../room/composer/markdown";
import { MessageBody } from "./MessageBody";

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
