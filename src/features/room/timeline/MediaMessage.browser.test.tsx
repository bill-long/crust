/**
 * Browser-mode round-trip for the encrypted non-image media renderers
 * (Media Phase 5, #279): download ciphertext → verify → decrypt → play /
 * download the plaintext, with a closed failure on tamper. Uses real WebCrypto
 * and a stubbed `fetch` serving ciphertext produced exactly like the Phase 4
 * send path (AES-256-CTR + SHA-256 of the ciphertext).
 */

import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EncryptedFileInfo } from "../composer/media/attachmentCrypto";
import { MediaAudio } from "./MediaAudio";
import { MediaFile } from "./MediaFile";
import { MediaVideo } from "./MediaVideo";

function bytesToBase64Unpadded(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++)
		binary += String.fromCharCode(bytes[i]);
	return btoa(binary).replace(/=+$/, "");
}
function bytesToBase64Url(bytes: Uint8Array): string {
	return bytesToBase64Unpadded(bytes).replace(/\+/g, "-").replace(/\//g, "_");
}

async function encryptAttachment(
	plaintext: Uint8Array,
): Promise<{ file: EncryptedFileInfo; ciphertext: ArrayBuffer }> {
	const keyBytes = crypto.getRandomValues(new Uint8Array(32));
	const counter = new Uint8Array(16);
	counter.set(crypto.getRandomValues(new Uint8Array(8)), 0);
	const key = await crypto.subtle.importKey(
		"raw",
		keyBytes,
		{ name: "AES-CTR" },
		false,
		["encrypt"],
	);
	const data = new Uint8Array(new ArrayBuffer(plaintext.byteLength));
	data.set(plaintext);
	const ciphertext = await crypto.subtle.encrypt(
		{ name: "AES-CTR", counter, length: 64 },
		key,
		data,
	);
	const digest = await crypto.subtle.digest("SHA-256", ciphertext);
	return {
		ciphertext,
		file: {
			url: "mxc://example.com/ciphertext",
			key: { k: bytesToBase64Url(keyBytes) },
			iv: bytesToBase64Unpadded(counter),
			hashes: { sha256: bytesToBase64Unpadded(new Uint8Array(digest)) },
			v: "v2",
		},
	};
}

function stubFetch(body: ArrayBuffer): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(body, { status: 200 })),
	);
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("encrypted MediaVideo", () => {
	it("decrypts on play and renders the plaintext as a blob URL", async () => {
		const { file, ciphertext } = await encryptAttachment(
			new TextEncoder().encode("decrypted-video-bytes"),
		);
		stubFetch(ciphertext);

		const { findByLabelText } = render(() => (
			<MediaVideo
				httpUrl="https://hs.example/cipher"
				file={file}
				mimetype="video/mp4"
				posterUrl={null}
				label="clip.mp4"
				isEncrypted={true}
				reserveWidth={320}
				reserveHeight={240}
			/>
		));

		// Click-to-load: nothing is fetched until the user activates the player.
		expect(fetch).not.toHaveBeenCalled();
		const play = await findByLabelText("Play video: clip.mp4");
		fireEvent.click(play);

		const video = (await findByLabelText("clip.mp4")) as HTMLVideoElement;
		expect(video.getAttribute("src")).toMatch(/^blob:/);
	});

	it("fails closed (no <video>) when the ciphertext is tampered", async () => {
		const { file, ciphertext } = await encryptAttachment(
			new Uint8Array([1, 2, 3, 4]),
		);
		const corrupted = ciphertext.slice(0);
		new Uint8Array(corrupted)[0] ^= 0xff;
		stubFetch(corrupted);

		const { findByLabelText, findByText, queryByLabelText } = render(() => (
			<MediaVideo
				httpUrl="https://hs.example/cipher"
				file={file}
				mimetype="video/mp4"
				posterUrl={null}
				label="clip.mp4"
				isEncrypted={true}
				reserveWidth={320}
				reserveHeight={240}
			/>
		));

		fireEvent.click(await findByLabelText("Play video: clip.mp4"));
		await findByText(/couldn't decrypt video/i);
		expect(queryByLabelText("clip.mp4")).toBeNull();
	});

	it("decrypts info.thumbnail_file eagerly and shows it as a poster before play", async () => {
		// Distinct keys/ciphertexts for the video and its thumbnail, served by
		// URL so the eager poster decrypt and the click-gated video decrypt each
		// resolve their own bytes.
		const video = await encryptAttachment(
			new TextEncoder().encode("video-bytes"),
		);
		const thumb = await encryptAttachment(
			// A real PNG header so the decrypted blob is a plausible image.
			new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		);
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				url.includes("thumb")
					? new Response(thumb.ciphertext, { status: 200 })
					: new Response(video.ciphertext, { status: 200 }),
			),
		);

		const { container, findByLabelText } = render(() => (
			<MediaVideo
				httpUrl="https://hs.example/cipher-video"
				file={video.file}
				mimetype="video/mp4"
				posterUrl={null}
				thumbnailUrl="https://hs.example/cipher-thumb"
				thumbnailFile={thumb.file}
				thumbnailMimetype="image/png"
				label="clip.mp4"
				isEncrypted={true}
				reserveWidth={320}
				reserveHeight={240}
			/>
		));

		// The poster image appears on the idle placeholder before any play click,
		// sourced from the decrypted blob (not the ciphertext URL).
		await waitFor(() => {
			const posterImg = container.querySelector("img");
			expect(posterImg?.getAttribute("src")).toMatch(/^blob:/);
		});

		// And it carries through to the playing <video> as the poster attribute.
		fireEvent.click(await findByLabelText("Play video: clip.mp4"));
		const playing = (await findByLabelText("clip.mp4")) as HTMLVideoElement;
		expect(playing.getAttribute("src")).toMatch(/^blob:/);
		await waitFor(() =>
			expect(playing.getAttribute("poster")).toMatch(/^blob:/),
		);
	});

	it("fails open (no poster, play affordance intact) when the thumbnail is tampered", async () => {
		const video = await encryptAttachment(
			new TextEncoder().encode("video-bytes"),
		);
		const thumb = await encryptAttachment(new Uint8Array([1, 2, 3, 4]));
		const corruptedThumb = thumb.ciphertext.slice(0);
		new Uint8Array(corruptedThumb)[0] ^= 0xff;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) =>
				url.includes("thumb")
					? new Response(corruptedThumb, { status: 200 })
					: new Response(video.ciphertext, { status: 200 }),
			),
		);

		const { container, findByLabelText } = render(() => (
			<MediaVideo
				httpUrl="https://hs.example/cipher-video"
				file={video.file}
				mimetype="video/mp4"
				posterUrl={null}
				thumbnailUrl="https://hs.example/cipher-thumb"
				thumbnailFile={thumb.file}
				thumbnailMimetype="image/png"
				label="clip.mp4"
				isEncrypted={true}
				reserveWidth={320}
				reserveHeight={240}
			/>
		));

		// The tampered thumbnail decrypt fails (fail-open): no poster <img> on the
		// placeholder, and the video still plays — with no poster attribute — once
		// activated. By the time the playing <video> appears the poster decrypt has
		// settled, so a missing poster reflects the fail-open, not a race.
		const play = await findByLabelText("Play video: clip.mp4");
		expect(container.querySelector("img")).toBeNull();
		fireEvent.click(play);
		const playing = (await findByLabelText("clip.mp4")) as HTMLVideoElement;
		expect(playing.getAttribute("src")).toMatch(/^blob:/);
		expect(playing.getAttribute("poster")).toBeNull();
	});
});

describe("encrypted MediaAudio", () => {
	it("decrypts on load and renders the plaintext as a blob URL", async () => {
		const { file, ciphertext } = await encryptAttachment(
			new TextEncoder().encode("decrypted-audio-bytes"),
		);
		stubFetch(ciphertext);

		const { findByLabelText } = render(() => (
			<MediaAudio
				httpUrl="https://hs.example/cipher"
				file={file}
				mimetype="audio/mpeg"
				label="song.mp3"
				isEncrypted={true}
			/>
		));

		expect(fetch).not.toHaveBeenCalled();
		fireEvent.click(await findByLabelText("Load audio: song.mp3"));

		const audio = (await findByLabelText("song.mp3")) as HTMLAudioElement;
		expect(audio.getAttribute("src")).toMatch(/^blob:/);
	});
});

describe("encrypted MediaFile", () => {
	it("decrypts on click and saves the plaintext blob", async () => {
		const { file, ciphertext } = await encryptAttachment(
			new TextEncoder().encode("decrypted-file-bytes"),
		);
		stubFetch(ciphertext);

		// Capture the download without triggering a real navigation, and confirm
		// a Blob (not the ciphertext URL) is what gets saved.
		const createObjUrl = vi
			.spyOn(URL, "createObjectURL")
			.mockReturnValue("blob:fake");
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		const anchorClick = vi
			.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(() => {});

		const { findByLabelText } = render(() => (
			<MediaFile
				httpUrl="https://hs.example/cipher"
				file={file}
				mimetype="application/pdf"
				filename="report.pdf"
				size={2048}
				isEncrypted={true}
			/>
		));

		fireEvent.click(await findByLabelText(/download report\.pdf/i));

		await waitFor(() => expect(anchorClick).toHaveBeenCalled());
		expect(createObjUrl).toHaveBeenCalledTimes(1);
		expect(createObjUrl.mock.calls[0][0]).toBeInstanceOf(Blob);
	});

	it("fails closed (shows an error, no download) when the ciphertext is tampered", async () => {
		const { file, ciphertext } = await encryptAttachment(
			new Uint8Array([5, 6, 7, 8]),
		);
		const corrupted = ciphertext.slice(0);
		new Uint8Array(corrupted)[0] ^= 0xff;
		stubFetch(corrupted);

		const anchorClick = vi
			.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(() => {});

		const { findByLabelText, findByText } = render(() => (
			<MediaFile
				httpUrl="https://hs.example/cipher"
				file={file}
				mimetype="application/pdf"
				filename="report.pdf"
				size={2048}
				isEncrypted={true}
			/>
		));

		fireEvent.click(await findByLabelText(/download report\.pdf/i));
		await findByText(/couldn't download file/i);
		expect(anchorClick).not.toHaveBeenCalled();
	});
});
