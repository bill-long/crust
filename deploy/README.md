# Deploying Crust

Crust ships as a static SPA inside an `nginx-unprivileged` container
(non-root, listening on port 8080). The image is published to GitHub
Container Registry (GHCR) by the `publish` job in the CI workflow
(`.github/workflows/ci.yml`) - after the tests pass - on every push to
`main` and on `v*` tags.

Image: `ghcr.io/bill-long/crust`

The published image is built with `VITE_BASE_PATH=/crust/` baked in, so all
asset and route URLs live under `/crust/`. The image is intended to be served
from the `/crust/` sub-path of the host site.

Tags:
- `latest` - latest `main`
- `main` - same as above, branch-named
- `sha-<7chars>` - immutable per-commit
- `1.2.3`, `1.2` - on semver tags

## First-time GHCR setup

GHCR packages created by Actions default to **private**. To allow the server to
`docker pull` anonymously:

1. After the first successful CI run that publishes the image, open the package
   settings linked from the repository's "Packages" tab.
2. Under "Danger Zone", change visibility to **Public**.

Alternatively, keep it private and log in on the server (use stdin to avoid
leaking the token via shell history):
`echo "$PAT" | docker login ghcr.io -u <username> --password-stdin`
where `$PAT` is a personal access token with `read:packages`.

## Server deployment

> **Prerequisite:** the GHCR package must be public, or run
> `docker login ghcr.io` on the server first. See the
> [First-time GHCR setup](#first-time-ghcr-setup) section above.

```bash
# One-time
mkdir -p ~/crust && cd ~/crust
# Copy deploy/docker-compose.yml here, then create config.json. The simplest
# starting point is the repo's default:
curl -fsSLO https://raw.githubusercontent.com/bill-long/crust/main/public/config.json
# Edit config.json to taste, then:
docker compose up -d
```

> **Important:** `config.json` MUST exist on the host before `docker compose up`.
> If it does not, Docker silently creates an empty directory at that path,
> mounts it over the image's baked-in file, and the SPA fails to load at
> runtime with a 403 on `/crust/config.json`.

Then add the `/crust/` location block from `nginx-location.conf.example` to the
existing host vhost, and reload nginx:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

The existing site's TLS certificate already covers the sub-path, so no new
certbot run is needed.

## Updating

```bash
cd ~/crust
docker compose pull && docker compose up -d && docker image prune -f
```

> **Upgrade note (nginx-unprivileged switch):** deployments created while the
> image still ran root nginx on port 80 must edit their existing
> `docker-compose.yml` before pulling: change the port mapping from
> `"127.0.0.1:8083:80"` to `"127.0.0.1:8083:8080"`. The container now listens
> on 8080 only, so the old mapping serves nothing (the host proxy will 502)
> without any error from `docker compose`.

Rollback to a known-good build by pinning a sha tag in `docker-compose.yml`:

```yaml
image: ghcr.io/bill-long/crust:sha-abc1234
```

## Runtime configuration

`config.json` is bind-mounted into the container at
`/usr/share/nginx/html/config.json`, so you can edit branding, homeserver list,
Element Call URL, etc. without rebuilding. See `public/config.json` in the repo
for the schema and defaults baked into the image.

After editing, no restart is needed - nginx serves it on the next request, and
the bundled cache headers (`expires -1` for `config.json`) ensure clients
re-fetch it on reload.

## Background push notifications (Sygnal + Web Push)

Crust is a PWA and can deliver **background** notifications (while the app is
closed) via a self-hosted [Sygnal](https://github.com/matrix-org/sygnal) push
gateway using its `webpush` pushkin. This is optional — without it, Crust still
shows in-app desktop notifications while open.

Topology: browser ⟶ (Push API subscription) ⟶ homeserver pusher ⟶
`https://strange.pizza/_matrix/push/v1/notify` ⟶ nginx ⟶ Sygnal ⟶ the
browser's push service ⟶ the service worker shows the notification.

The Continuwuity homeserver implements pushers and POSTs notifications to the
gateway URL the client registers, so no homeserver changes are needed.

### 1. Generate VAPID keys

VAPID keys identify this gateway to browser push services. They are free,
self-generated, and never expire. Generate them once with the Sygnal image:

```bash
cd ~/crust
mkdir -p vapid
docker run --rm -v "$PWD/vapid:/vapid" -w /vapid \
  --entrypoint vapid matrixdotorg/sygnal:latest --gen --applicationServerKey
```

This writes `vapid/private_key.pem` (+ `public_key.pem`) and prints an
**Application Server Key** string. Copy that string — it goes in `config.json`
below. (Re-derive it later with the same command's `--applicationServerKey`
output if lost.)

### 2. Configure Sygnal

```bash
# Copy the example and edit the contact email (the app_id default already
# matches the config.json below):
curl -fsSLO https://raw.githubusercontent.com/bill-long/crust/main/deploy/sygnal.yaml.example
mv sygnal.yaml.example sygnal.yaml
$EDITOR sygnal.yaml   # set vapid_contact_email
```

### 3. Point Crust at the gateway

Add a `push` block to `config.json` (served to clients). The `appId` MUST match
the app key in `sygnal.yaml`, and `vapidPublicKey` is the Application Server Key
from step 1:

```json
"push": {
  "vapidPublicKey": "BHDunEhVBbl-lVD3ICUfxPlIavtUGZtlMQ5fGCgkstZ...",
  "gatewayUrl": "https://strange.pizza/_matrix/push/v1/notify",
  "appId": "pizza.strange.crust.webpush"
}
```

### 4. Route the gateway through nginx

Add the `/_matrix/push/` location from `nginx-location.conf.example` to the
`strange.pizza` server block (alongside the existing `/_matrix/` location), then
`sudo nginx -t && sudo systemctl reload nginx`.

### 5. Start Sygnal

```bash
docker compose --profile push up -d
```

> Use `--profile push` on every `docker compose up` (and `pull`) once enabled,
> otherwise compose will stop the `sygnal` container as out-of-profile.

Verify: `curl -sS https://strange.pizza/_matrix/push/v1/notify` should return a
JSON error from Sygnal (e.g. method/parse error), confirming nginx reaches the
gateway. (Omit `-f`: a bare GET returns HTTP 4xx, which `-f` would turn into a
silent failure with no body.) Then toggle **Settings → Notifications →
Background notifications** in Crust, accept the browser permission prompt, close
the app, and send yourself a message from another device.

## Changing the sub-path

The GHCR image is built with `VITE_BASE_PATH=/crust/`. To host under a
different path, rebuild locally:

```bash
docker build --build-arg VITE_BASE_PATH=/some-other-path/ -t crust:custom .
```

Or change the `build-args` value in the `publish` job of
`.github/workflows/ci.yml`.
