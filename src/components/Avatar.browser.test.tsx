import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, For } from "solid-js";
import { afterEach, expect, it } from "vitest";
import "../styles/global.css";
import { Avatar } from "./Avatar";

afterEach(cleanup);

it("reserves the same box for loaded images and failed-image initials at every size", async () => {
	const good = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50"/></svg>')}`;
	const [url, setUrl] = createSignal(good);
	const sizes = ["xs", "md", "lg", "xl", "2xl", "3xl", "tile"] as const;
	const { container } = render(() => (
		<div class="flex flex-col items-start">
			<For each={sizes}>
				{(size) => (
					<div
						data-size={size}
						class="flex h-48 w-80 items-center justify-center [container-type:size]"
					>
						<Avatar url={url()} initial="A" alt={size} size={size} />
					</div>
				)}
			</For>
		</div>
	));
	await expect
		.poll(() =>
			[...container.querySelectorAll("img")].every(
				(img) => img.complete && img.naturalWidth > 0,
			),
		)
		.toBe(true);
	const before = [...container.querySelectorAll("img")].map((img) => {
		const rect = img.getBoundingClientRect();
		return [rect.width, rect.height];
	});
	expect(before.slice(0, 6)).toEqual(
		[16, 32, 40, 64, 80, 96].map((size) => [size, size]),
	);
	expect(before[6]?.[0]).toBeCloseTo(86.4, 1);
	setUrl("data:image/png;base64,broken");
	await expect.poll(() => container.querySelectorAll("img").length).toBe(0);
	const after = [...container.querySelectorAll('[role="img"]')].map((el) => {
		const rect = el.getBoundingClientRect();
		return [rect.width, rect.height];
	});
	expect(after).toEqual(before);
});
