# Media action invariants

Read this before changing media downloads, image previews, or room exports.
These rules capture the failure classes exposed by [PR #695](https://github.com/bill-long/crust/pull/695).
Implementation and tests remain the source of truth for behavior. Update this map
when ownership changes; do not copy its rules into every caller or add parallel
tests that merely restate the implementation.

## Ownership and lifetime

- Authenticate explicit actions with the Matrix client that initiated them, using
  its current token. Do not attach credentials to another origin or embed them
  in links or exports. A new tab or download cannot assume service-worker control.
- Distinguish an unsupported server version from a failed capability probe. A
  transport error or failed authenticated request is not evidence that legacy
  media works; do not silently downgrade to legacy access on those errors.
- Define cancellation by meaningful media changes, not projected object identity.
  Closing, switching media, or changing its URL, MIME type, filename, encryption
  details, or download permission ends pending actions. An unrelated message,
  reaction, or display-name refresh must not end them.
- Capture the action's cancellation signal. A stale completion must not reset a
  newer action's state, show its error, or save its bytes. Prevent duplicate
  pending downloads and previews while allowing retry after completion or failure.
- Cancellation must cross asynchronous boundaries. If native window creation
  finishes after cancellation, close that specific window. Failed initialization
  also cleans up its window. Successfully opened independent previews outlive
  the initiating lightbox; closing it only cancels unfinished work.

## Preview security

Render untrusted bytes as an image, not document markup. Test what happens when
users open the image URL itself as a document, including through the context menu:
SVG scripting being disabled inside an image element does not make an app-origin
Blob URL safe to navigate to. Browser previews use opaque-origin data URLs;
native previews have no app origin or privileged IPC access. Cleanup commands
must not allow a preview to close unrelated windows.

## Export portability and failure behavior

- Only bundled files receive download links. Unbundled attachments keep useful
  names and safe source identifiers, including encrypted MXC identifiers, without
  exposing keys, tokens, or unusable ciphertext links. Verify encrypted bytes
  before including plaintext.
- Extracted HTML must work offline. Archive-relative paths must match the files,
  with safe image extensions derived from MIME types. Unsupported or omitted emoji
  fall back to a nonempty alt label, then title, then `[emoji]`.
- Treat an abort signal and the UI cancellation callback as one cancellation
  condition throughout export. Cancellation produces no partial archive, even
  when attachment error handling catches an aborted request.
- Match visible errors to the attempted action and helper text to the selected
  format. Opening an image is not a download in the user's vocabulary; only HTML
  exports promise bundled custom emoji.

## Regression coverage map

Extend the relevant existing test when changing an invariant. The entries below
identify different observable boundaries, not a requirement to test every rule
at every layer.

| Boundary | Owning regression coverage |
| --- | --- |
| Account/token ownership, origin restriction, no downgrade on probe/auth failure | [media.test.ts](../src/client/media.test.ts) |
| File and lightbox actions with legacy media disabled; duplicate clicks; cancellation vs unrelated refresh; visible preview errors | [MediaMessage.browser.test.tsx](../src/features/room/timeline/MediaMessage.browser.test.tsx) |
| Popup reservation/cleanup, SVG document origin, delayed native creation after cancellation | [imagePreview.browser.test.ts](../src/app/imagePreview.browser.test.ts) |
| Actual Windows decoding, opaque origin, IPC restrictions, cleanup and main-window protection | [check-native-media.mjs](../scripts/check-native-media.mjs); build/run instructions in [desktop README](../desktop/README.md#authenticated-image-previews) |
| Authenticated bytes in the archive, missing encryption keys, no partial archive after abort | [exportRoom.test.ts](../src/features/room/export/exportRoom.test.ts) |
| Emoji deduplication, authenticated fetching, matching archive/HTML paths and missing-image labels | [exportEmoji.test.ts](../src/features/room/export/exportEmoji.test.ts) |
| Unbundled attachment metadata, absent dead links/tokens, nonempty emoji fallback | [serializers.test.ts](../src/features/room/export/serializers.test.ts) |
| Safe image suffixes and MIME normalization | [imageExtension.test.ts](../src/lib/imageExtension.test.ts) |

The browser suite uses Chromium. The native smoke check runs real Windows WebView2;
the mocked native IPC browser tests do not replace it or validate other platforms.
Offline file loading was also checked manually during #695: an extensionless SVG
failed to decode from a `file://` HTML page; the generated `.svg` filename decoded.
That manual check is not automated coverage. When changing archive formats or
asset naming, extract an actual export and open it offline in the target browser.

For the full review procedure and how to report validation limits, use
[PR workflow](pr-workflow.md#address-findings). Avoid creating a second checklist
that can drift from that procedure.
