# Deploying Crust

Crust ships as a static SPA inside an `nginx:alpine` container. The image is
published to GitHub Container Registry (GHCR) by the `Publish image` workflow
on every push to `main` and on `v*` tags.

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

1. After the first successful `publish.yml` run, open the package settings
   linked from the repository's "Packages" tab.
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

## Changing the sub-path

The GHCR image is built with `VITE_BASE_PATH=/crust/`. To host under a
different path, rebuild locally:

```bash
docker build --build-arg VITE_BASE_PATH=/some-other-path/ -t crust:custom .
```

Or change the `build-args` value in `.github/workflows/publish.yml`.
