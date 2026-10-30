FROM node:22-slim AS build
WORKDIR /app/apps/web
RUN corepack enable
COPY apps/web/package.json apps/web/pnpm-lock.yaml* apps/web/pnpm-workspace.yaml* ./
RUN pnpm install --frozen-lockfile
COPY apps/web/ ./
COPY contracts /app/contracts
RUN pnpm exec vite build

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
