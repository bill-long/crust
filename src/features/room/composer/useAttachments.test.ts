import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAttachments } from "./useAttachments";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("useAttachments paste handling", () => {
	it("skips absent clipboard slots and queues later images", () => {
		const createObjectURL = vi.fn(() => "blob:pasted-preview");
		const NativeURL = URL;
		class TestURL extends NativeURL {
			static override createObjectURL = createObjectURL;
		}
		vi.stubGlobal("URL", TestURL);
		const file = new File(["image bytes"], "pasted.bin", {
			type: "image/png",
		});
		const items = {
			1: {
				kind: "file",
				type: "image/png",
				getAsFile: () => file,
			},
			length: 2,
		} as unknown as DataTransferItemList;
		const preventDefault = vi.fn();
		const event = {
			clipboardData: { items },
			preventDefault,
		} as unknown as ClipboardEvent;

		createRoot((dispose) => {
			try {
				const { attachments, onPaste } = useAttachments(() => null);

				onPaste(event);

				expect(attachments).toHaveLength(1);
				expect(attachments[0]?.file).toBe(file);
				expect(attachments[0]?.kind).toBe("image");
				expect(attachments[0]?.previewUrl).toBe("blob:pasted-preview");
				expect(createObjectURL).toHaveBeenCalledWith(file);
				expect(preventDefault).toHaveBeenCalledOnce();
			} finally {
				dispose();
			}
		});
	});
});
