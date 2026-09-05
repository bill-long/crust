import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createComposerFormatting } from "./composerFormatting";

interface FormattingHarness {
	formatting: ReturnType<typeof createComposerFormatting>;
	getText: () => string;
	setTextarea: (textarea: HTMLTextAreaElement | undefined) => void;
	autoResize: ReturnType<typeof vi.fn>;
}

const frames: FrameRequestCallback[] = [];

beforeEach(() => {
	frames.length = 0;
	vi.stubGlobal(
		"requestAnimationFrame",
		vi.fn((callback: FrameRequestCallback) => {
			frames.push(callback);
			return frames.length;
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function flushFrame(): void {
	const callback = frames.shift();
	if (!callback) throw new Error("No animation frame was scheduled");
	callback(0);
}

function makeTextarea(
	selectionStart: number,
	selectionEnd = selectionStart,
): HTMLTextAreaElement {
	return {
		selectionStart,
		selectionEnd,
		focus: vi.fn(),
		setSelectionRange: vi.fn(),
	} as unknown as HTMLTextAreaElement;
}

function setup(
	initialText: string,
	initialTextarea: HTMLTextAreaElement | undefined,
): FormattingHarness {
	let text = initialText;
	let textarea = initialTextarea;
	const autoResize = vi.fn();
	const formatting = createComposerFormatting({
		getTextarea: () => textarea,
		text: () => text,
		setText: (value) => {
			text = value;
		},
		autoResize,
	});

	return {
		formatting,
		getText: () => text,
		setTextarea: (value) => {
			textarea = value;
		},
		autoResize,
	};
}

describe("createComposerFormatting", () => {
	it("does nothing when the textarea is not mounted", () => {
		const harness = setup("unchanged", undefined);

		harness.formatting.wrapInline("**");

		expect(harness.getText()).toBe("unchanged");
		expect(harness.autoResize).not.toHaveBeenCalled();
		expect(requestAnimationFrame).not.toHaveBeenCalled();
	});

	it("wraps the live selection and restores focus and selection in a frame", () => {
		const textarea = makeTextarea(4, 9);
		const harness = setup("say hello now", textarea);

		harness.formatting.wrapInline("**");

		expect(harness.getText()).toBe("say **hello** now");
		expect(harness.autoResize).toHaveBeenCalledOnce();
		expect(textarea.focus).not.toHaveBeenCalled();
		expect(textarea.setSelectionRange).not.toHaveBeenCalled();

		flushFrame();
		expect(textarea.focus).toHaveBeenCalledOnce();
		expect(textarea.setSelectionRange).toHaveBeenCalledWith(6, 11);
	});

	it("leaves a collapsed caret between inline markers", () => {
		const textarea = makeTextarea(1);
		const harness = setup("x", textarea);

		harness.formatting.wrapInline("`");
		flushFrame();

		expect(harness.getText()).toBe("x``");
		expect(textarea.setSelectionRange).toHaveBeenCalledWith(2, 2);
	});

	it("uses the selection as a link label and selects the URL placeholder", () => {
		const textarea = makeTextarea(4, 8);
		const harness = setup("see docs now", textarea);

		harness.formatting.insertLink();
		flushFrame();

		expect(harness.getText()).toBe("see [docs](url) now");
		expect(textarea.setSelectionRange).toHaveBeenCalledWith(11, 14);
	});

	it("supplies a link label when the selection is empty", () => {
		const textarea = makeTextarea(3);
		const harness = setup("go ", textarea);

		harness.formatting.insertLink();
		flushFrame();

		expect(harness.getText()).toBe("go [text](url)");
		expect(textarea.setSelectionRange).toHaveBeenCalledWith(10, 13);
	});

	it("prefixes every partially selected line from the first line start", () => {
		const textarea = makeTextarea(8, 14);
		const harness = setup("intro\nalpha\nbeta\noutro", textarea);

		harness.formatting.prefixLines("> ");
		flushFrame();

		expect(harness.getText()).toBe("intro\n> alpha\n> beta\noutro");
		expect(textarea.setSelectionRange).toHaveBeenCalledWith(6, 18);
	});

	it("keeps an empty selection collapsed after its prefix", () => {
		const textarea = makeTextarea(2);
		const harness = setup("abcd", textarea);

		harness.formatting.prefixLines("- ");
		flushFrame();

		expect(harness.getText()).toBe("- abcd");
		expect(textarea.setSelectionRange).toHaveBeenCalledWith(4, 4);
	});

	it("skips deferred focus restoration when the textarea unmounts", () => {
		const textarea = makeTextarea(0, 4);
		const harness = setup("word", textarea);

		harness.formatting.wrapInline("**");
		harness.setTextarea(undefined);
		flushFrame();

		expect(harness.getText()).toBe("**word**");
		expect(textarea.focus).not.toHaveBeenCalled();
		expect(textarea.setSelectionRange).not.toHaveBeenCalled();
	});
});
