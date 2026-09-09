import { cleanup, render, screen } from "@solidjs/testing-library";
import { EventType, type MatrixClient } from "matrix-js-sdk";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import "../../../styles/global.css";
import { createMockClient, createMockRoom } from "../../../test/mockClient";
import { RoomGeneralTab } from "./RoomGeneralTab";

afterEach(cleanup);

it("saves an already-previewed avatar when a newer upload fails", async () => {
	const roomId = "!room:example.com";
	const room = createMockRoom(roomId, [], [], { name: "Alpha" });
	const client = createMockClient(new Map([[roomId, room]]));
	let finishFirstSave!: () => void;
	client.sendStateEvent.mockImplementationOnce(
		() =>
			new Promise<void>((resolve) => {
				finishFirstSave = resolve;
			}),
	);
	client.uploadContent
		.mockResolvedValueOnce({ content_uri: "mxc://example.com/a" })
		.mockResolvedValueOnce({ content_uri: "mxc://example.com/b" })
		.mockRejectedValueOnce(new Error("Upload unavailable"));
	const picture = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"/>')}`;
	vi.spyOn(client, "mxcUrlToHttp").mockImplementation(
		(mxc) => `${picture}#${mxc}`,
	);
	const { container } = render(() => (
		<RoomGeneralTab
			client={client as unknown as MatrixClient}
			roomId={roomId}
		/>
	));
	const input = container.querySelector<HTMLInputElement>('input[type="file"]');
	if (!input) throw new Error("Avatar picker missing");
	const pick = (name: string) =>
		page
			.elementLocator(input)
			.upload(new File(["image"], name, { type: "image/png" }));
	await pick("a.png");
	await expect.poll(() => client.sendStateEvent.mock.calls.length).toBe(1);
	await pick("b.png");
	await expect
		.poll(() => container.querySelector("img")?.getAttribute("src"))
		.toContain("mxc://example.com/b");
	await pick("c.png");
	finishFirstSave();
	await expect
		.poll(() => screen.queryByRole("alert")?.textContent)
		.toContain("Upload unavailable");
	expect(client.sendStateEvent).toHaveBeenLastCalledWith(
		roomId,
		EventType.RoomAvatar,
		{ url: "mxc://example.com/b" },
		"",
	);
});
