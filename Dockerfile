# Build
# Pin the build stage to the native build platform so cross-arch images don't
# emulate the (slow) Node/pnpm build under QEMU — the Vite output is static and
# architecture-independent, so it's built once and reused for every target arch.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
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
FROM nginx:alpine
COPY docker-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
