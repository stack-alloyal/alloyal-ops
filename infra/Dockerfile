# ═══════════════════════════════════════════════════════════════════════════
# Imagem multi-alvo do Alloyal Pulse. ARM64 (Oracle Ampere).
#
# Um Dockerfile, três alvos: worker, web-internal, web-portal. O compose escolhe
# via `target:`. Mantém a instalação de dependências em cache compartilhado
# entre os três, o que importa numa VM de 4 vCPU.
# ═══════════════════════════════════════════════════════════════════════════
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/*/package.json packages/
COPY apps/*/package.json apps/
# `--mount=type=cache` acelera rebuild sem inflar a imagem final.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

# ─── worker ────────────────────────────────────────────────────────────────
FROM base AS worker
ENV NODE_ENV=production TZ=UTC
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/worker ./apps/worker
USER node
CMD ["node", "apps/worker/dist/main.js"]

# ─── superfície interna ────────────────────────────────────────────────────
FROM base AS web-internal
ENV NODE_ENV=production TZ=UTC PORT=3000
COPY --from=build /app/apps/web-internal/.next/standalone ./
COPY --from=build /app/apps/web-internal/.next/static ./apps/web-internal/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web-internal/server.js"]

# ─── superfície do cliente ─────────────────────────────────────────────────
FROM base AS web-portal
ENV NODE_ENV=production TZ=UTC PORT=3000
COPY --from=build /app/apps/web-portal/.next/standalone ./
COPY --from=build /app/apps/web-portal/.next/static ./apps/web-portal/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web-portal/server.js"]
