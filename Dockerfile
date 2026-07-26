# Build
# Pin the build stage to the native build platform so cross-arch images don't
# emulate the (slow) Node/pnpm build under QEMU — the Vite output is static and
# architecture-independent, so it's built once and reused for every target arch.
# Base images are pinned by multi-arch manifest-list digest (issue #314) so
# builds are reproducible and immune to tag repointing; the tag stays for
# readability. To bump: docker buildx imagetools inspect <image>:<tag>
FROM --platform=$BUILDPLATFORM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS build
RUN corepack enable
WORKDIR /app
# Sub-path hosting: pass `--build-arg VITE_BASE_PATH=/crust/` to bake the
# app's asset and route URLs under `/crust/`. Trailing slash required.
# Defaults to `/` (root-hosted).
ARG VITE_BASE_PATH=/
ENV VITE_BASE_PATH=$VITE_BASE_PATH
COPY package.json pnpm-lock.yaml ./
# --ignore-scripts: the only install lifecycle script is the root `prepare`
# (scripts/enable-hooks.mjs), a dev-only git-hooks setup that (a) hasn't been
# copied into the image at this layer - only package.json + pnpm-lock.yaml
# precede this step - so install dies with "Cannot find module" and breaks the
# publish; and (b) has nothing to do here anyway (no .git in the image). pnpm 10
# already blocks dependency build scripts by default (no onlyBuiltDependencies
# is configured), so this skips nothing the Vite build needs.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY . .
RUN pnpm build

# Serve
# nginx-unprivileged (issue #314): runs as the non-root `nginx` user (uid 101)
# with the pid file and temp paths relocated to /tmp, so no root-owned process
# ever runs in the container. It listens on 8080 (non-root can't bind 80);
# docker-nginx.conf's `listen` and the deploy/docker-compose.yml port mapping
# match.
FROM nginxinc/nginx-unprivileged:alpine@sha256:18d67281256ded39ff65e010ae4f831be18f19356f83c60bc546492c7eb6dd23
COPY docker-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
# busybox wget ships in the alpine base; --spider makes it a HEAD-style probe.
# The SPA fallback serves index.html for /, so a 200 means nginx is up and the
# app shell is readable.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q --spider http://127.0.0.1:8080/ || exit 1
CMD ["nginx", "-g", "daemon off;"]
