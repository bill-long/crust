# GIF Spike — Cross-Client URL Preview Testing

**Goal:** Before building the GIF picker, verify that sending a raw GIF CDN URL
as `m.room.message`/`m.text` produces an acceptable experience across clients.
If cross-client rendering is too poor, revisit the approach before investing in
the picker.

## Approach

Crust's GIF feature sends a **plain text message** containing a GIF URL (e.g.,
`https://media.giphy.com/media/{id}/giphy.gif`). It does NOT upload/re-host the
GIF as `m.image`. This means:

- **Crust itself** can detect the URL pattern and render an inline preview.
- **Other clients** may or may not unfurl the URL into a visible GIF, depending
  on their URL preview support, the room's encryption state, and the user's
  settings.

## Test URLs

Use these specific URLs for testing. They cover Giphy's CDN format and typical
GIF hosting patterns.

### Giphy CDN URLs
```
https://media.giphy.com/media/l0MYt5jPR6QX5pnqM/giphy.gif
https://media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif
https://media.giphy.com/media/3o7aCSPqXE5C6T8tBC/giphy.webp
https://media.giphy.com/media/xT9IgDEI1iZyb2wqo8/200w.gif
```

### Tenor CDN URLs (for comparison)
```
https://media.tenor.com/images/abc123/tenor.gif
https://c.tenor.com/someId/tenor.gif
```

### Direct GIF URLs (generic hosting)
```
https://i.imgur.com/example.gif
```

## Test Matrix

Test each URL type in each scenario. Record the result for each cell.

**Legend:**
- ✅ Inline GIF rendered (plays automatically or on click)
- 🔗 Link shown, clickable, but no inline preview
- 🔗📷 Link with a static preview thumbnail (URL unfurl)
- ❌ No link, no preview, broken
- ⚠️ Partial (describe in notes)

### Unencrypted Room

| URL Type | Element Web | Element Android | Element iOS | Cinny |
|----------|-------------|-----------------|-------------|-------|
| Giphy `.gif` | | | | |
| Giphy `.webp` | | | | |
| Giphy `200w.gif` | | | | |
| Tenor `.gif` | | | | |
| Direct `.gif` | | | | |

### Encrypted Room

| URL Type | Element Web | Element Android | Element iOS | Cinny |
|----------|-------------|-----------------|-------------|-------|
| Giphy `.gif` | | | | |
| Giphy `.webp` | | | | |
| Giphy `200w.gif` | | | | |
| Tenor `.gif` | | | | |
| Direct `.gif` | | | | |

### URL Preview Settings

Document the default URL preview settings for each client/room type:

| Client | Unencrypted Default | Encrypted Default | User Can Toggle? |
|--------|--------------------|--------------------|-----------------|
| Element Web | | | |
| Element Android | | | |
| Element iOS | | | |
| Cinny | | | |

## Questions to Answer

1. **Does any client render Giphy URLs inline as GIFs without URL preview
   server support?** (i.e., does the client itself fetch and render the image
   when it sees a `.gif`/`.webp` URL?)

2. **In encrypted rooms, do any clients show URL previews?** Element Web
   reportedly disables them by default for privacy. What about mobile clients
   and Cinny?

3. **Is the `.gif` vs `.webp` extension significant?** Do any clients treat
   `.webp` differently from `.gif` for inline rendering?

4. **Does Giphy's `200w.gif` (resized variant) behave differently?** Some
   clients may whitelist `media.giphy.com` specifically.

5. **Does the message `msgtype` matter?** We're sending `m.text`. Would
   `m.notice` behave differently? (We should NOT use `m.image` since we're
   not uploading to MXC.)

6. **Is the experience acceptable for the "honest" approach?** The plan says
   "Crust renders such URLs inline locally; receivers in other clients may see
   only a link (this is honest, not solved everywhere)." Is a bare link
   acceptable, or is it confusing enough that we need a different approach?

## Alternative Approaches (if spike fails)

If the cross-client experience is unacceptable:

1. **Upload as `m.image`**: Download the GIF from the CDN and upload to MXC as
   `m.image`. Works everywhere but adds latency, bandwidth, and storage cost.
   Also loses attribution link to the provider.

2. **Hybrid**: Send `m.text` with URL for the message body, but ALSO include a
   `url` in `m.image`-style content. Non-standard but some clients may pick up
   the image.

3. **Custom event type**: Use `m.image` with `info.mimetype: image/gif` and a
   custom field pointing to the CDN URL. Other clients render the MXC copy;
   Crust can prefer the CDN URL for faster loading.

4. **Accept the limitation**: Ship with URL-only and clearly document the
   tradeoff. This is the plan's default stance.

## Findings

### Summary

**The CDN URL approach is the only TOS-compliant path.** The spike confirmed that
neither Element Web nor Cinny renders inline GIF previews from plain-text URLs —
they show bare clickable links. However, downloading and re-uploading GIFs to
MXC (`m.image`) violates Giphy, Tenor, and Klipy TOS, which all prohibit
re-hosting. This is the fundamental reason no Matrix client has shipped a native
GIF picker — the protocol and provider TOS are mutually exclusive.

**Crust's approach: CDN URL + client-side inline rendering.** We send the GIF as
`m.text` with the CDN URL (TOS-compliant), and Crust detects GIF URLs in the
timeline and renders them inline. Other clients see a link — "if you want GIFs,
use Crust." This is honest, legal, and a genuine differentiator.

### Element Web Results

| Room | Rendering |
|------|-----------|
| Unencrypted | 🔗 Plain blue hyperlinks — no inline preview |
| Encrypted | 🔗 Plain blue hyperlinks — no inline preview |

Element Web does not have a native GIF picker — only third-party widgets.

### Cinny Results

| Room | Rendering |
|------|-----------|
| Unencrypted | 🔗 Plain URLs — no inline preview |
| Encrypted | 🔒 UTD (cross-device key issue, not a rendering test) |

### Why MXC Upload Is Not an Option

All three major GIF providers (Giphy, Tenor, Klipy) explicitly prohibit
downloading and re-hosting their content. Their TOS require serving GIFs from
their CDN URLs only. Uploading to a Matrix homeserver is re-hosting.

This is the fundamental reason no Matrix client has shipped a native GIF picker:
- **Element** (issue element-hq/element-meta#321, open since 2015, 111 👍):
  overengineered it into a server-side widget/sticker API, never shipped
- **Cinny** (issue cinnyapp/cinny#1557): maintainer identified the TOS/MXC
  impasse; proposed MXC cache with deduplication, which also violates TOS
- **FluffyChat** (issue #700): open feature request, no implementation
- **Nheko**: no feature request found

### Decision

**CDN URL + Crust-only inline rendering.** TOS-compliant, honest about
cross-client limitations. Crust detects known GIF provider URLs in the timeline
and renders them inline. Other clients see a clickable link. This is a genuine
product differentiator — "if you want GIFs, use Crust."

### Encrypted Room Considerations

In encrypted rooms, the CDN URL is encrypted in the message body — only
decrypted clients see it. However, when Crust fetches the GIF for inline
rendering, the user's IP is exposed to the GIF provider's CDN. This is the same
privacy trade-off as any URL preview. The encrypted-room warning from the
original plan is still relevant but reframed: "This GIF will be fetched from
[provider] — your IP will be visible to them."
