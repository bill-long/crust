import { type Component, createMemo } from "solid-js";
import { encodeVerificationQr } from "./qrCode";

interface QrCodeDisplayProps {
	/** Raw bytes from `VerificationRequest.generateQRCode()`. */
	bytes: Uint8ClampedArray;
	/** Accessible name for the code. */
	label: string;
}

/**
 * Renders the verification QR code as an inline SVG.
 *
 * Vector rather than a canvas bitmap: the code stays crisp at any UI zoom,
 * and the fixed box below reserves its layout before the encode runs, so
 * nothing shifts when it appears.
 *
 * The black-on-white is deliberate and not themed - a QR code is a
 * machine-readable image, and phone cameras want the polarity and contrast
 * they were designed around, not the surface tokens.
 */
const QrCodeDisplay: Component<QrCodeDisplayProps> = (props) => {
	const code = createMemo(() => encodeVerificationQr(props.bytes));

	return (
		<div class="rounded-lg bg-white p-3">
			<svg
				class="h-64 w-64"
				viewBox={`0 0 ${code().size} ${code().size}`}
				xmlns="http://www.w3.org/2000/svg"
				role="img"
				aria-label={props.label}
			>
				<path class="fill-black" d={code().path} />
			</svg>
		</div>
	);
};

export { QrCodeDisplay };
