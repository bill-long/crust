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
import { MessageBody } from "./MessageBody";

afterEach(cleanup);

const client = createMockClient() as unknown as MatrixClient;

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
