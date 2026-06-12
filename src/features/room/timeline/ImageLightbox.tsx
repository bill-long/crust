import {
	type Component,
	createEffect,
	createMemo,
	createSignal,
	createUniqueId,
	Match,
	on,
	onCleanup,
	Show,
	Switch,
} from "solid-js";
import { formatBytes } from "../../../lib/formatBytes";
import { trackAppModalOpen } from "../../../stores/modalStack";
import { userSettings } from "../../../stores/settings";
import type { EncryptedFileInfo } from "../composer/media/attachmentCrypto";
import { createDecryptedObjectUrl } from "../composer/media/useDecryptedMedia";

const FOCUSABLE =
	'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface LightboxImage {
	eventId: string;
	fullUrl: string;
	mimetype: string | null;
	size: number | null;
	filename: string | null;
	width: number | null;
	height: number | null;
	senderName: string;
	timestamp: number;
	isEncrypted: boolean;
	/**
	 * EncryptedFile descriptor when `isEncrypted`. `fullUrl` then points at the
	 * ciphertext; the lightbox downloads + decrypts it for display/download.
	 */
	encryptedFile: EncryptedFileInfo | null;
}

interface ImageLightboxProps {
	open: () => boolean;
	onClose: () => void;
	image: () => LightboxImage | null;
	onPrev?: () => void;
	onNext?: () => void;
	hasPrev?: () => boolean;
	hasNext?: () => boolean;
	/**
	 * Element to focus when the lightbox closes if the original trigger
	 * is gone (e.g. virtualized message scrolled out). Typically the
	 * timeline scroller.
	 */
	fallbackFocus?: () => HTMLElement | null | undefined;
}

const MIN_ABS_SCALE = 0.05;
const MAX_ABS_SCALE = 10;
const ZOOM_STEP = 1.25;
const DRAG_THRESHOLD_PX = 4;

function clamp(n: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, n));
}

function formatTimestamp(ts: number, hourFmt: "12h" | "24h"): string {
	const d = new Date(ts);
	return d.toLocaleString([], {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		hour12: hourFmt === "12h",
	});
}

function extFromMime(mime: string | null): string {
	if (!mime) return "bin";
	const lower = mime.toLowerCase();
	if (lower === "image/jpeg" || lower === "image/jpg") return "jpg";
	const slash = lower.indexOf("/");
	if (slash === -1) return "bin";
	const sub = lower.slice(slash + 1);
	// Strip parameters like "; charset=…"
	const semi = sub.indexOf(";");
	return (semi === -1 ? sub : sub.slice(0, semi)).trim() || "bin";
}

function sanitizeFilename(name: string, fallback: string): string {
	// Strip path separators and control chars; collapse whitespace.
	const cleaned = name
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control chars from user-supplied filenames is the point
		.replace(/[\\/\x00-\x1f\x7f]+/g, "_")
		.replace(/\s+/g, " ")
		.trim();
	return cleaned.length > 0 ? cleaned : fallback;
}

/** Normalize a `WheelEvent.deltaY` to a pixel-ish magnitude. */
function normalizeWheelDelta(e: WheelEvent): number {
	// DOM_DELTA_PIXEL = 0, DOM_DELTA_LINE = 1, DOM_DELTA_PAGE = 2
	if (e.deltaMode === 1) return e.deltaY * 16;
	if (e.deltaMode === 2) return e.deltaY * 400;
	return e.deltaY;
}

const ImageLightbox: Component<ImageLightboxProps> = (props) => {
	trackAppModalOpen(props.open);
	let overlayRef!: HTMLDivElement;
	let imgRef: HTMLImageElement | undefined;
	let panSurfaceRef: HTMLDivElement | undefined;
	let closeBtnRef: HTMLButtonElement | undefined;
	let previousFocus: HTMLElement | null = null;

	const titleId = createUniqueId();

	// Encrypted images: download the ciphertext (`fullUrl`) and decrypt it to a
	// blob URL for display / download / open. Plain images use `fullUrl`
	// directly. Only active while an encrypted image is shown.
	const decrypted = createDecryptedObjectUrl(
		() => {
			const img = props.image();
			return img?.encryptedFile ? img.fullUrl : null;
		},
		() => props.image()?.encryptedFile ?? null,
		() => props.image()?.mimetype ?? null,
	);
	/**
	 * The URL to actually render/download. `isEncrypted` is authoritative: for
	 * any encrypted image we only ever expose the decrypted blob (null until it
	 * decrypts, and forever null when the descriptor is missing/invalid), never
	 * `fullUrl` — which for encrypted events is the ciphertext.
	 */
	const displaySrc = (): string | null => {
		const img = props.image();
		if (!img) return null;
		if (!img.isEncrypted) return img.fullUrl;
		// Encrypted: only ever the decrypted blob, and only when a valid
		// descriptor actually produced one. `encryptedFile` (not just a possibly
		// stale `decrypted.url()`) gates it, so a malformed encrypted image can't
		// surface ciphertext or a previous image's blob.
		return img.encryptedFile ? decrypted.url() : null;
	};

	/**
	 * Open the image in a new tab. For encrypted images, mint a *fresh* object
	 * URL from the decrypted blob and revoke it on a delay — the lightbox's own
	 * managed URL is revoked on unmount / image change, which would break a tab
	 * still loading it. Plain images just open their http URL.
	 */
	const openInNewTab = (): void => {
		const img = props.image();
		if (!img) return;
		if (img.isEncrypted) {
			const blob = decrypted.blob();
			if (!blob) return;
			const url = URL.createObjectURL(blob);
			window.open(url, "_blank", "noopener,noreferrer");
			// Long enough for the new tab to fetch the blob into its own context.
			setTimeout(() => URL.revokeObjectURL(url), 60_000);
		} else {
			window.open(img.fullUrl, "_blank", "noopener,noreferrer");
		}
	};

	// Natural (intrinsic) image dimensions, set from `<img>` onLoad
	// or from metadata when known.
	const [naturalSize, setNaturalSize] = createSignal<{
		w: number;
		h: number;
	} | null>(null);
	const [viewport, setViewport] = createSignal<{ w: number; h: number }>({
		w: typeof window !== "undefined" ? window.innerWidth : 1024,
		h: typeof window !== "undefined" ? window.innerHeight : 768,
	});
	const [scale, setScale] = createSignal(1);
	const [translate, setTranslate] = createSignal({ x: 0, y: 0 });
	const [downloadError, setDownloadError] = createSignal<string | null>(null);
	const [imgLoadError, setImgLoadError] = createSignal(false);

	// Reserve some viewport for the metadata strip + toolbar so the
	// "fit" scale doesn't crowd into them.
	const VIEWPORT_VPAD = 140;
	const VIEWPORT_HPAD = 32;

	const fitScale = createMemo(() => {
		const n = naturalSize();
		if (!n) return 1;
		const vp = viewport();
		const availW = Math.max(64, vp.w - VIEWPORT_HPAD);
		const availH = Math.max(64, vp.h - VIEWPORT_VPAD);
		const s = Math.min(availW / n.w, availH / n.h, 1);
		return clamp(s, MIN_ABS_SCALE, MAX_ABS_SCALE);
	});

	// Floor at MIN_ABS_SCALE so very-large images (where fitScale already
	// clamps to MIN_ABS_SCALE) can't be zoomed below the absolute floor.
	const minScale = createMemo(() => Math.max(MIN_ABS_SCALE, fitScale() * 0.5));
	const isFitted = createMemo(() => Math.abs(scale() - fitScale()) < 1e-4);

	// Clamp pan so at least 64px of the image stays visible on every
	// side. With no natural size, do nothing.
	const clampTranslate = (
		tx: number,
		ty: number,
		s: number,
	): {
		x: number;
		y: number;
	} => {
		const n = naturalSize();
		if (!n) return { x: tx, y: ty };
		const vp = viewport();
		const scaledW = n.w * s;
		const scaledH = n.h * s;
		// Image is centered at (vp.w/2, vp.h/2) with translate applied.
		// Allowed translate range keeps at least MARGIN visible.
		const MARGIN = 64;
		const maxX = Math.max(0, (scaledW + vp.w) / 2 - MARGIN);
		const maxY = Math.max(0, (scaledH + vp.h) / 2 - MARGIN);
		return {
			x: clamp(tx, -maxX, maxX),
			y: clamp(ty, -maxY, maxY),
		};
	};

	const resetToFit = (): void => {
		setScale(fitScale());
		setTranslate({ x: 0, y: 0 });
	};

	const setActualSize = (): void => {
		const s = clamp(1, minScale(), MAX_ABS_SCALE);
		const t = clampTranslate(translate().x, translate().y, s);
		setScale(s);
		setTranslate(t);
	};

	const zoomBy = (factor: number): void => {
		const current = scale();
		const target = clamp(current * factor, minScale(), MAX_ABS_SCALE);
		const t = clampTranslate(translate().x, translate().y, target);
		setScale(target);
		setTranslate(t);
	};

	const zoomToPoint = (
		factor: number,
		clientX: number,
		clientY: number,
	): void => {
		const current = scale();
		const target = clamp(current * factor, minScale(), MAX_ABS_SCALE);
		// Use the actual applied ratio (post-clamp) for the translate
		// math so a clamped zoom doesn't jump the image.
		const applied = target / current;
		if (applied === 1) return;
		const vp = viewport();
		const cx = vp.w / 2;
		const cy = vp.h / 2;
		const tx = translate().x;
		const ty = translate().y;
		// Vector from image center to cursor:
		const dx = clientX - cx - tx;
		const dy = clientY - cy - ty;
		const newTx = tx + dx * (1 - applied);
		const newTy = ty + dy * (1 - applied);
		const clamped = clampTranslate(newTx, newTy, target);
		setScale(target);
		setTranslate(clamped);
	};

	// Lifecycle: capture focus, viewport listeners, reset state on
	// open/close and image change.
	createEffect(
		on(props.open, (isOpen, wasOpen) => {
			if (isOpen && !wasOpen) {
				previousFocus = document.activeElement as HTMLElement | null;
				setDownloadError(null);
				setImgLoadError(false);
				// If the descriptor has explicit dims, seed naturalSize early so
				// the fitScale memo can give us a sensible starting scale
				// before <img> loads.
				const img = props.image();
				if (img?.width && img?.height) {
					setNaturalSize({ w: img.width, h: img.height });
				} else {
					setNaturalSize(null);
				}
				queueMicrotask(() => {
					closeBtnRef?.focus();
				});
			} else if (!isOpen && wasOpen) {
				restoreFocus();
			}
		}),
	);

	// Reset scale / translate / errors whenever the image changes.
	createEffect(
		on(
			() => props.image()?.eventId ?? null,
			(_id) => {
				if (!props.open()) return;
				setDownloadError(null);
				setImgLoadError(false);
				const img = props.image();
				if (img?.width && img?.height) {
					setNaturalSize({ w: img.width, h: img.height });
				} else {
					setNaturalSize(null);
				}
				// Defer to next microtask so `fitScale` memo sees fresh
				// naturalSize before we read it.
				queueMicrotask(() => {
					setScale(fitScale());
					setTranslate({ x: 0, y: 0 });
				});
			},
			{ defer: true },
		),
	);

	// Re-fit when naturalSize / viewport changes while currently fitted.
	// We must compare scale against the *previous* fitScale, because once
	// fitScale recomputes the current scale will no longer match the new
	// fitScale even though the user never manually zoomed.
	createEffect(
		on(fitScale, (newFit, oldFit) => {
			if (!props.open()) return;
			if (naturalSize() === null) {
				setScale(newFit);
				setTranslate({ x: 0, y: 0 });
				return;
			}
			// First run after open: always snap to fit. Subsequent runs:
			// snap only if the user was still in fit mode (i.e. current
			// scale matches the *previous* fitScale).
			if (oldFit === undefined || Math.abs(scale() - oldFit) < 1e-4) {
				setScale(newFit);
				setTranslate({ x: 0, y: 0 });
			}
		}),
	);

	const restoreFocus = (): void => {
		const target =
			previousFocus && document.body.contains(previousFocus)
				? previousFocus
				: (props.fallbackFocus?.() ?? null);
		previousFocus = null;
		if (target) {
			try {
				target.focus();
			} catch {
				// noop
			}
		}
	};

	onCleanup(() => {
		restoreFocus();
	});

	// Window resize tracking — only while the lightbox is open. Avoids
	// recomputing `viewport` / `fitScale` for an unmounted overlay.
	const onResize = (): void => {
		setViewport({ w: window.innerWidth, h: window.innerHeight });
	};
	if (typeof window !== "undefined") {
		createEffect(
			on(props.open, (isOpen) => {
				if (!isOpen) return;
				// Sync viewport on (re-)open in case it changed while closed.
				onResize();
				window.addEventListener("resize", onResize);
				onCleanup(() => window.removeEventListener("resize", onResize));
			}),
		);
	}

	const tryClose = (): void => {
		if (dragState !== null) return;
		props.onClose();
	};

	const handleKeyDown = (e: KeyboardEvent): void => {
		if (e.key === "Escape") {
			e.stopPropagation();
			tryClose();
			return;
		}
		if (e.key === "Tab") {
			const focusable = Array.from(
				overlayRef.querySelectorAll<HTMLElement>(FOCUSABLE),
			);
			if (focusable.length === 0) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (e.shiftKey && document.activeElement === first) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
			return;
		}
		if (e.key === "ArrowRight") {
			if (props.hasNext?.()) {
				e.preventDefault();
				props.onNext?.();
			}
			return;
		}
		if (e.key === "ArrowLeft") {
			if (props.hasPrev?.()) {
				e.preventDefault();
				props.onPrev?.();
			}
			return;
		}
		if (e.key === "+" || e.key === "=") {
			e.preventDefault();
			zoomBy(ZOOM_STEP);
			return;
		}
		if (e.key === "-" || e.key === "_") {
			e.preventDefault();
			zoomBy(1 / ZOOM_STEP);
			return;
		}
		if (e.key === "0") {
			e.preventDefault();
			resetToFit();
			return;
		}
		if (e.key === "1") {
			e.preventDefault();
			setActualSize();
		}
	};

	// Wheel zoom (also catches trackpad pinch — browsers fire wheel
	// with ctrlKey for pinch). We always preventDefault so the page
	// doesn't scroll/zoom underneath.
	const handleWheel = (e: WheelEvent): void => {
		e.preventDefault();
		const dy = normalizeWheelDelta(e);
		if (dy === 0) return;
		// 100px of wheel delta ≈ 1 step; clamp the per-event factor so a
		// single jumbo trackpad gesture can't jump 20x at once.
		const stepExp = clamp(-dy / 200, -1.5, 1.5);
		const factor = ZOOM_STEP ** stepExp;
		zoomToPoint(factor, e.clientX, e.clientY);
	};

	// Pointer drag pan + drag-vs-click tracking.
	let dragState: {
		pointerId: number;
		startX: number;
		startY: number;
		originTx: number;
		originTy: number;
		moved: boolean;
	} | null = null;
	// Set to a recent timestamp after a drag ends so the subsequent
	// click on the backdrop doesn't close the lightbox.
	let lastDragEndAt = 0;

	const onPointerDown = (e: PointerEvent): void => {
		if (e.button !== 0) return;
		if (scale() <= fitScale() + 1e-4) return; // no pan when at or below fit
		dragState = {
			pointerId: e.pointerId,
			startX: e.clientX,
			startY: e.clientY,
			originTx: translate().x,
			originTy: translate().y,
			moved: false,
		};
		(e.currentTarget as Element).setPointerCapture(e.pointerId);
	};

	const onPointerMove = (e: PointerEvent): void => {
		if (!dragState || dragState.pointerId !== e.pointerId) return;
		const dx = e.clientX - dragState.startX;
		const dy = e.clientY - dragState.startY;
		if (!dragState.moved && Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
			dragState.moved = true;
		}
		const t = clampTranslate(
			dragState.originTx + dx,
			dragState.originTy + dy,
			scale(),
		);
		setTranslate(t);
	};

	const onPointerUp = (e: PointerEvent): void => {
		if (!dragState || dragState.pointerId !== e.pointerId) return;
		const moved = dragState.moved;
		try {
			(e.currentTarget as Element).releasePointerCapture(e.pointerId);
		} catch {
			// noop
		}
		dragState = null;
		if (moved) lastDragEndAt = performance.now();
	};

	const onDoubleClick = (e: MouseEvent): void => {
		e.preventDefault();
		if (isFitted()) {
			// Zoom to 100% centered on cursor
			const current = scale();
			const target = clamp(1, minScale(), MAX_ABS_SCALE);
			if (Math.abs(target - current) < 1e-4) return;
			zoomToPoint(target / current, e.clientX, e.clientY);
		} else {
			resetToFit();
		}
	};

	const onBackdropClick = (e: MouseEvent): void => {
		if (e.target !== e.currentTarget) return;
		if (performance.now() - lastDragEndAt < 250) return;
		tryClose();
	};

	// Download via fetch -> blob with sanitized filename. On failure,
	// surface an inline error; the user can still use "Open in new tab"
	// or right-click → Save As as a fallback.
	const handleDownload = async (): Promise<void> => {
		const img = props.image();
		if (!img) return;
		setDownloadError(null);
		const fallbackName = `image-${img.eventId.replace(/[^a-zA-Z0-9_-]/g, "_")}.${extFromMime(img.mimetype)}`;
		const filename = sanitizeFilename(
			img.filename ?? fallbackName,
			fallbackName,
		);
		// For encrypted images download the already-decrypted blob, never the
		// ciphertext. The blob URL is valid while the lightbox is open.
		const src = displaySrc();
		if (!src) {
			setDownloadError("Download failed: image is not ready");
			return;
		}
		try {
			const res = await fetch(src, { credentials: "omit" });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const blob = await res.blob();
			const objUrl = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = objUrl;
			a.download = filename;
			document.body.appendChild(a);
			a.click();
			a.remove();
			setTimeout(() => URL.revokeObjectURL(objUrl), 0);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			setDownloadError(`Download failed: ${msg}`);
		}
	};

	const onImgLoad = (e: Event): void => {
		const el = e.currentTarget as HTMLImageElement;
		if (el.naturalWidth > 0 && el.naturalHeight > 0) {
			setNaturalSize({ w: el.naturalWidth, h: el.naturalHeight });
		}
	};

	const onImgError = (): void => {
		setImgLoadError(true);
	};

	const transformStyle = createMemo(() => {
		const t = translate();
		const s = scale();
		return `translate(${t.x}px, ${t.y}px) scale(${s})`;
	});

	const zoomPercent = createMemo(() => Math.round(scale() * 100));

	return (
		<Show when={props.open()}>
			<div
				ref={overlayRef}
				class="fixed inset-0 z-50 flex flex-col bg-black/90 backdrop-blur-sm"
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				tabIndex={-1}
				onKeyDown={handleKeyDown}
				onClick={onBackdropClick}
			>
				{/* Header / toolbar */}
				<div class="flex items-center justify-between gap-2 border-b border-white/10 bg-black/40 px-3 py-2 text-text-primary">
					<div id={titleId} class="min-w-0 flex-1 truncate text-sm">
						<Show
							when={props.image()}
							fallback={<span class="text-text-muted">Image</span>}
						>
							{(img) => (
								<span class="font-medium">{img().filename ?? "Image"}</span>
							)}
						</Show>
					</div>
					<div class="flex flex-wrap items-center justify-end gap-1">
						<Show when={props.hasPrev?.()}>
							<button
								type="button"
								onClick={() => props.onPrev?.()}
								class="rounded p-2 text-text-primary hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
								aria-label="Previous image"
							>
								<svg
									class="h-5 w-5"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									aria-hidden="true"
								>
									<polyline points="15 18 9 12 15 6" />
								</svg>
							</button>
						</Show>
						<Show when={props.hasNext?.()}>
							<button
								type="button"
								onClick={() => props.onNext?.()}
								class="rounded p-2 text-text-primary hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
								aria-label="Next image"
							>
								<svg
									class="h-5 w-5"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									aria-hidden="true"
								>
									<polyline points="9 18 15 12 9 6" />
								</svg>
							</button>
						</Show>
						<span class="mx-1 h-5 w-px bg-white/20" aria-hidden="true" />
						<button
							type="button"
							onClick={() => zoomBy(1 / ZOOM_STEP)}
							class="rounded p-2 text-text-primary hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
							aria-label="Zoom out"
						>
							<svg
								class="h-5 w-5"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								aria-hidden="true"
							>
								<circle cx="11" cy="11" r="7" />
								<line x1="8" y1="11" x2="14" y2="11" />
								<line x1="20" y1="20" x2="16.65" y2="16.65" />
							</svg>
						</button>
						<button
							type="button"
							onClick={resetToFit}
							class="rounded px-2 py-1 text-xs text-text-primary hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
							aria-label="Fit to viewport"
							aria-current={isFitted() ? "true" : undefined}
						>
							Fit
						</button>
						<button
							type="button"
							onClick={setActualSize}
							class="rounded px-2 py-1 text-xs tabular-nums text-text-primary hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
							aria-label="Zoom to 100%"
						>
							{zoomPercent()}%
						</button>
						<button
							type="button"
							onClick={() => zoomBy(ZOOM_STEP)}
							class="rounded p-2 text-text-primary hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
							aria-label="Zoom in"
						>
							<svg
								class="h-5 w-5"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								aria-hidden="true"
							>
								<circle cx="11" cy="11" r="7" />
								<line x1="11" y1="8" x2="11" y2="14" />
								<line x1="8" y1="11" x2="14" y2="11" />
								<line x1="20" y1="20" x2="16.65" y2="16.65" />
							</svg>
						</button>
						<span class="mx-1 h-5 w-px bg-white/20" aria-hidden="true" />
						<Show when={props.image()}>
							{(img) => (
								<>
									<button
										type="button"
										onClick={handleDownload}
										disabled={img().isEncrypted && !displaySrc()}
										title={
											img().isEncrypted &&
											(!img().encryptedFile || decrypted.failed())
												? "Image can't be decrypted"
												: img().isEncrypted && !displaySrc()
													? "Decrypting…"
													: "Download"
										}
										class="rounded p-2 text-text-primary hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
										aria-label="Download image"
									>
										<svg
											class="h-5 w-5"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											stroke-width="2"
											aria-hidden="true"
										>
											<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
											<polyline points="7 10 12 15 17 10" />
											<line x1="12" y1="15" x2="12" y2="3" />
										</svg>
									</button>
									<Show when={displaySrc()}>
										{(src) => {
											// New nodes per call — a single shared JSX node can't live
											// in both Show branches.
											const renderOpenIcon = () => (
												<>
													<span class="sr-only">Open in new tab</span>
													<svg
														class="h-5 w-5"
														viewBox="0 0 24 24"
														fill="none"
														stroke="currentColor"
														stroke-width="2"
														aria-hidden="true"
													>
														<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
														<polyline points="15 3 21 3 21 9" />
														<line x1="10" y1="14" x2="21" y2="3" />
													</svg>
												</>
											);
											const openClass =
												"rounded p-2 text-text-primary hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover";
											// Encrypted: a button minting a fresh, independently-revoked
											// blob URL (the displaySrc blob is revoked on unmount and
											// would break the opened tab). Plain: a normal anchor.
											return (
												<Show
													when={!props.image()?.isEncrypted}
													fallback={
														<button
															type="button"
															onClick={openInNewTab}
															class={openClass}
															aria-label="Open in new tab"
														>
															{renderOpenIcon()}
														</button>
													}
												>
													<a
														href={src()}
														target="_blank"
														rel="noopener noreferrer"
														class={openClass}
														aria-label="Open in new tab"
													>
														{renderOpenIcon()}
													</a>
												</Show>
											);
										}}
									</Show>
								</>
							)}
						</Show>
						<button
							type="button"
							ref={closeBtnRef}
							onClick={tryClose}
							class="rounded p-2 text-text-primary hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover"
							aria-label="Close"
						>
							<svg
								class="h-5 w-5"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								stroke-width="2"
								aria-hidden="true"
							>
								<line x1="18" y1="6" x2="6" y2="18" />
								<line x1="6" y1="6" x2="18" y2="18" />
							</svg>
						</button>
					</div>
				</div>

				{/* Image surface: interactive pan/zoom region inside the
				    role="dialog" overlay. The dialog itself owns the
				    keyboard handlers; this surface only forwards pointer
				    / wheel gestures. */}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: interactive surface inside role="dialog" with keyboard handled at the dialog level */}
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: Esc / arrow / zoom keys are handled by the parent dialog's onKeyDown */}
				<div
					ref={panSurfaceRef}
					class="relative flex flex-1 select-none items-center justify-center overflow-hidden"
					style={{
						cursor: scale() > fitScale() + 1e-4 ? "grab" : "zoom-in",
						"touch-action": "none",
					}}
					// Non-passive wheel listener so preventDefault() actually
					// stops page scroll while zooming. Solid's onWheel attaches
					// via addEventListener, which defaults to passive: true for
					// wheel events; the on: namespace lets us override that.
					on:wheel={{ handleEvent: handleWheel, passive: false }}
					onPointerDown={onPointerDown}
					onPointerMove={onPointerMove}
					onPointerUp={onPointerUp}
					onPointerCancel={onPointerUp}
					onDblClick={onDoubleClick}
					onClick={(e) => {
						// Click on empty area around the image closes the
						// lightbox, mirroring Discord's behavior. Don't close
						// if the user just finished a drag, or if they clicked
						// the image itself.
						if (e.target !== e.currentTarget) return;
						if (performance.now() - lastDragEndAt < 250) return;
						tryClose();
					}}
				>
					<Show
						when={props.image()}
						fallback={<div class="text-text-muted">No image</div>}
					>
						{(img) => (
							<Switch>
								{/* Encrypted with no usable descriptor (malformed
								    `content.file`) or a failed download/verify/decrypt →
								    fail closed. `isEncrypted` is authoritative so we never
								    fall through to rendering the ciphertext `fullUrl`. */}
								<Match
									when={
										img().isEncrypted &&
										(!img().encryptedFile || decrypted.failed())
									}
								>
									<div class="max-w-md rounded bg-surface-1/90 p-6 text-center text-sm text-text-secondary shadow-xl">
										<div class="mb-1 font-semibold text-text-primary">
											Couldn't decrypt image
										</div>
										<p>
											This encrypted image could not be decrypted or failed its
											integrity check.
										</p>
									</div>
								</Match>
								{/* Encrypted: still downloading / decrypting. */}
								<Match when={img().isEncrypted && !decrypted.url()}>
									<div class="text-text-muted">Decrypting…</div>
								</Match>
								{/* Plain image failed to load. */}
								<Match when={imgLoadError()}>
									<div class="max-w-md rounded bg-surface-1/90 p-6 text-center text-sm text-text-secondary shadow-xl">
										<div class="mb-1 font-semibold text-text-primary">
											Couldn't load image
										</div>
										<p>The full-resolution image failed to load.</p>
									</div>
								</Match>
								<Match when={displaySrc()}>
									{(src) => (
										<img
											ref={imgRef}
											src={src()}
											alt={img().filename ?? "Image"}
											onLoad={onImgLoad}
											onError={onImgError}
											draggable={false}
											style={{
												transform: transformStyle(),
												"transform-origin": "center center",
												"max-width": "none",
												"max-height": "none",
												"will-change": "transform",
											}}
											class="block"
										/>
									)}
								</Match>
							</Switch>
						)}
					</Show>
				</div>

				{/* Metadata strip */}
				<div class="flex flex-wrap items-center justify-between gap-3 border-t border-white/10 bg-black/40 px-3 py-2 text-xs text-text-muted">
					<Show when={props.image()}>
						{(img) => (
							<>
								<div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
									<span class="truncate text-text-secondary">
										{img().senderName}
									</span>
									<span aria-hidden="true">·</span>
									<span>
										{formatTimestamp(
											img().timestamp,
											userSettings().timeFormat,
										)}
									</span>
									<Show when={naturalSize()}>
										{(n) => (
											<>
												<span aria-hidden="true">·</span>
												<span class="tabular-nums">
													{n().w} × {n().h}
												</span>
											</>
										)}
									</Show>
									<Show when={img().size !== null}>
										<span aria-hidden="true">·</span>
										<span class="tabular-nums">
											{formatBytes(img().size as number)}
										</span>
									</Show>
								</div>
								<Show when={downloadError()}>
									<div role="alert" class="text-danger-text">
										{downloadError()}
									</div>
								</Show>
							</>
						)}
					</Show>
				</div>
			</div>
		</Show>
	);
};

export { ImageLightbox };
