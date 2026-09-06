import { describe, expect, it, vi } from "vitest";
import { useAttachments } from "./useAttachments";

describe("useAttachments paste handling", () => {
	it("skips absent clipboard slots and queues later images", () => {
		const file = new File(["image bytes"], "pasted.bin", {
			type: "application/octet-stream",
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
		const { attachments, onPaste } = useAttachments(() => null);

		onPaste(event);

		expect(attachments).toHaveLength(1);
		expect(attachments[0]?.file).toBe(file);
		expect(preventDefault).toHaveBeenCalledOnce();
	});
});
