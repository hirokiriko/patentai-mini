FROM node:22-bookworm-slim AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
ENV NEXT_TELEMETRY_DISABLED=1

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.1.3 --activate

FROM base AS deps

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY scripts ./scripts

RUN pnpm install --frozen-lockfile

FROM base AS builder

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/vendor ./vendor
COPY . .

ARG MANAGED_BUILD_SHA
RUN test -n "$MANAGED_BUILD_SHA" && printf '%s' "$MANAGED_BUILD_SHA" > .managed-build-sha
RUN pnpm build && pnpm exec tsc -p scripts/koho-cloud-import.tsconfig.json && pnpm exec tsc -p scripts/managed-watch-cloud.tsconfig.json

FROM base AS runner

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

EXPOSE 3000

COPY --from=builder /app ./

CMD ["pnpm", "start"]
