# Build
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
# Sub-path hosting: pass `--build-arg VITE_BASE_PATH=/crust/` to bake the
# app's asset and route URLs under `/crust/`. Trailing slash required.
# Defaults to `/` (root-hosted).
ARG VITE_BASE_PATH=/
ENV VITE_BASE_PATH=$VITE_BASE_PATH
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# Serve
FROM nginx:alpine
COPY docker-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
