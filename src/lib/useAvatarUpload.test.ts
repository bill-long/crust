import { createRoot, createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { useAvatarUpload } from "./useAvatarUpload";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}

const file = (name = "avatar.png") =>
	new File(["image"], name, { type: "image/png" });

function fixture() {
	const uploadContent = vi.fn(async (_file: File) => ({
		content_uri: "mxc://server/image",
	}));
	const onUploaded = vi.fn(
		async (_url: string, _isCurrent: () => boolean) => {},
	);
	return createRoot((dispose) => {
		const [scope, setScope] = createSignal("room-a");
		const upload = useAvatarUpload({ uploadContent }, { scope, onUploaded });
		return { upload, uploadContent, onUploaded, dispose, setScope };
	});
}

describe("useAvatarUpload", () => {
	it("keeps the latest selection when uploads complete out of order", async () => {
		const f = fixture();
		try {
			const old = deferred<{ content_uri: string }>();
			f.uploadContent.mockReturnValueOnce(old.promise);
			const pending = f.upload.pickFile(file("old.png"));
			await f.upload.pickFile(file("new.png"));
			old.resolve({ content_uri: "mxc://server/old" });
			await pending;
			expect(f.upload.mxc()).toBe("mxc://server/image");
			expect(f.onUploaded).toHaveBeenCalledTimes(1);
		} finally {
			f.dispose();
		}
	});

	it.each(["invalid", "oversized", "remove", "scope", "dispose"] as const)(
		"invalidates an outstanding upload on %s",
		async (action) => {
			const f = fixture();
			let disposed = false;
			try {
				const old = deferred<{ content_uri: string }>();
				f.uploadContent.mockReturnValueOnce(old.promise);
				const pending = f.upload.pickFile(file());
				if (action === "invalid")
					await f.upload.pickFile(
						new File(["text"], "text.txt", { type: "text/plain" }),
					);
				if (action === "oversized")
					await f.upload.pickFile(
						new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.png", {
							type: "image/png",
						}),
					);
				if (action === "remove") f.upload.remove();
				if (action === "scope") f.setScope("room-b");
				if (action === "dispose") {
					f.dispose();
					disposed = true;
				}
				old.resolve({ content_uri: "mxc://server/old" });
				await pending;
				expect(f.upload.mxc()).toBeNull();
				expect(f.onUploaded).not.toHaveBeenCalled();
				if (action !== "dispose") expect(f.upload.uploading()).toBe(false);
			} finally {
				if (!disposed) f.dispose();
			}
		},
	);

	it("reuses an uploaded file when retrying a failed profile save", async () => {
		const f = fixture();
		try {
			f.onUploaded.mockRejectedValueOnce(new TypeError("Failed to fetch"));
			await f.upload.pickFile(file());
			expect(f.upload.error()).toBe("Failed to upload avatar");
			await f.upload.retry();
			expect(f.uploadContent).toHaveBeenCalledTimes(1);
			expect(f.onUploaded).toHaveBeenCalledTimes(2);
			expect(f.upload.error()).toBeNull();
		} finally {
			f.dispose();
		}
	});

	it("lets callers update optimistically while an earlier save is pending", async () => {
		const f = fixture();
		try {
			const firstSave = deferred<void>();
			f.onUploaded.mockReturnValueOnce(firstSave.promise);
			const first = f.upload.pickFile(file("first.png"));
			await vi.waitFor(() => expect(f.onUploaded).toHaveBeenCalledTimes(1));
			const firstIsCurrent = f.onUploaded.mock.calls[0]?.[1];
			expect(firstIsCurrent?.()).toBe(true);
			await f.upload.pickFile(file("second.png"));
			expect(f.onUploaded).toHaveBeenCalledTimes(2);
			expect(firstIsCurrent?.()).toBe(false);
			firstSave.reject(new Error("old save failed"));
			await first;
			expect(f.upload.error()).toBeNull();
			expect(f.upload.uploading()).toBe(false);
		} finally {
			f.dispose();
		}
	});

	it("ignores a stale failure while the new upload is pending", async () => {
		const f = fixture();
		try {
			const old = deferred<{ content_uri: string }>();
			const current = deferred<{ content_uri: string }>();
			f.uploadContent
				.mockReturnValueOnce(old.promise)
				.mockReturnValueOnce(current.promise);
			const first = f.upload.pickFile(file("first.png"));
			const second = f.upload.pickFile(file("second.png"));
			old.reject(new Error("stale error"));
			await first;
			expect(f.upload.error()).toBeNull();
			expect(f.upload.uploading()).toBe(true);
			current.resolve({ content_uri: "mxc://server/current" });
			await second;
		} finally {
			f.dispose();
		}
	});
});
