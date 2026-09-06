# Dialog shells

Use `Modal` from `src/components/Modal.tsx` for a blocking app dialog. The
feature owns its panel, state, network operations, and inline errors. Modal
owns the overlay, Kobalte focus scope, initial/return focus, Escape isolation,
backdrop dismissal, and app-modal registration.

```tsx
<Modal
	open={open()}
	onClose={close}
	labelledBy={titleId}
	initialFocus={() => input}
	dismissible={!saving()}
>
	<form class="w-full max-w-md rounded-lg bg-surface-1 p-6 shadow-xl">
		{/* Dialog-specific content */}
	</form>
</Modal>
```

- Use `labelledBy` or `label`; `describedBy` is optional.
- `initialFocus` is an accessor because conditional fields may mount late.
  Without it, Kobalte chooses the first tabbable control. `contentRef` allows
  a step-based flow to focus the surface after replacing its controls.
- `dismissible={false}` blocks Escape/backdrop dismissal. A flow with a more
  nuanced policy (UIA prompt cancellation, export cancellation) keeps that
  policy in `onClose`. Buttons still use the feature's guarded handlers.
- `suspended` yields focus and makes the surface inert while a separately
  hosted crypto dialog is above it. Do not put an active inline child inside
  an inert parent: use `portaled` for that child, as key import/export do.
- Inline rendering preserves existing stacking and inherited zoom. Opt-in
  body portals apply `portal-scale` once. Do not add that class to inline
  surfaces. `class`/`style` customize outer geometry; focus styling is shared.
- `fallbackFocus` handles a disconnected opener (the virtualized image
  lightbox). `onBackdropClick` supports its drag-aware dismissal. Neither
  bypasses `suspended` or `dismissible`.
- Keep the internal stable content wrapper: Kobalte inserts focus sentinels
  into its Content, so a sole Solid Show/Switch must reconcile inside a
  separate DOM parent. Its `display: contents` preserves the panel layout.

## Migration audit (#593)

The hand-built modal shells now use Modal, and only `lib/focusTrap.ts` defines
the focusable selector. Feature dialogs no longer wire `trackAppModalOpen`,
`trapTabKey`, or `containFocusWhileOpen` themselves. Existing per-dialog
tests are retained; shared browser tests exercise focus, nested Escape,
pending/suspended states, dynamic panels, portals, and zoom.

Intentional exceptions:

- `FullCallOverlay` is a non-modal region; room/space navigation stays usable.
- Search, pinned-message, and thread-list panels are non-modal side panels.
- RoomPane's narrow-screen drawers already use Kobalte Dialog with their own
  drawer geometry; they are not hand-built modal copies.
- Lazy-loading backdrop placeholders contain no interactive dialog content.
- UIA panels and the recovery-key display are content inside a dialog, not
  independent overlays. Their step-specific focus transitions stay local.
