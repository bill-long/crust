const fs = require("fs");
const ti = "src/features/room/timeline/TimelineItem.tsx";
let t = fs.readFileSync(ti, "utf8");
// Reorder: altText (with its comment) should precede the imgEl comment.
const block =
	"\t\t\t\t\t\t\t\t\t\t\t// Encrypted images can't be rendered from their (scaled)\n" +
	"\t\t\t\t\t\t\t\t\t\t\t// ciphertext URL — download + decrypt the full file and\n" +
	"\t\t\t\t\t\t\t\t\t\t\t// show the plaintext blob instead.\n" +
	"\t\t\t\t\t\t\t\t\t\t\t\t// Alt text: the validated `mediaFilename` is already single-line\n" +
	"\t\t\t\t\t\t\t\t\t\t\t\t// and control-char-safe, unlike the raw `body` (which for a\n" +
	"\t\t\t\t\t\t\t\t\t\t\t\t// captioned image is the multi-line caption). Using the filename\n" +
	"\t\t\t\t\t\t\t\t\t\t\t\t// also avoids screen readers double-announcing the caption, which\n" +
	"\t\t\t\t\t\t\t\t\t\t\t\t// renders as adjacent visible text below.\n" +
	'\t\t\t\t\t\t\t\t\t\t\t\tconst altText = ev.mediaFilename || "Image";\n' +
	"\t\t\t\t\t\t\t\t\t\t\tconst imgEl = ev.mediaIsEncrypted ? (";
if (!t.includes(block)) throw new Error("block anchor missing");
const reordered =
	"\t\t\t\t\t\t\t\t\t\t\t// Alt text: the validated `mediaFilename` is already single-line\n" +
	"\t\t\t\t\t\t\t\t\t\t\t// and control-char-safe, unlike the raw `body` (which for a\n" +
	"\t\t\t\t\t\t\t\t\t\t\t// captioned image is the multi-line caption). Using the filename\n" +
	"\t\t\t\t\t\t\t\t\t\t\t// also avoids screen readers double-announcing the caption, which\n" +
	"\t\t\t\t\t\t\t\t\t\t\t// renders as adjacent visible text below.\n" +
	'\t\t\t\t\t\t\t\t\t\t\tconst altText = ev.mediaFilename || "Image";\n' +
	"\t\t\t\t\t\t\t\t\t\t\t// Encrypted images can't be rendered from their (scaled)\n" +
	"\t\t\t\t\t\t\t\t\t\t\t// ciphertext URL — download + decrypt the full file and\n" +
	"\t\t\t\t\t\t\t\t\t\t\t// show the plaintext blob instead.\n" +
	"\t\t\t\t\t\t\t\t\t\t\tconst imgEl = ev.mediaIsEncrypted ? (";
t = t.replace(block, reordered);
fs.writeFileSync(ti, t);
console.log("done");
