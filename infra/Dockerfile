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
# O ARGUMENTO `worker` NÃO É OPCIONAL. Sem ele, `main.js` roda em modo
# "inventario": imprime os ciclos declarados e SAI com código 0. Com
# `restart: always` isso vira laço de reinício — o contêiner parece vivo na
# lista, o log parece saudável (é a lista de ciclos, não um erro), e nenhum
# ciclo nunca roda. Foi assim que ele subiu pela primeira vez.
CMD ["node", "apps/worker/dist/main.js", "worker"]

# ─── superfície interna ────────────────────────────────────────────────────
FROM base AS web-internal
# HOSTNAME=0.0.0.0 é OBRIGATÓRIO, e a razão é sutil: o servidor standalone do Next
# usa `process.env.HOSTNAME` como endereço de bind, e o Docker define essa variável
# com o ID do contêiner. O ID resolve para o IP da rede PRIMÁRIA — então, num
# contêiner ligado a duas redes, o Next escuta em uma e recusa conexão na outra.
#
# Foi exatamente o que aconteceu: o app respondia 200 pela `pulse-net` e devolvia
# "connection refused" ao NPM, que chega pela `proxy-net`. O sintoma final seria um
# 502 Bad Gateway sem causa aparente — o contêiner de pé, o log limpo, e a porta
# aberta quando testada de dentro da rede errada.
ENV NODE_ENV=production TZ=UTC PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/apps/web-internal/.next/standalone ./
COPY --from=build /app/apps/web-internal/.next/static ./apps/web-internal/.next/static
# `public/` também NÃO entra no standalone sozinho — mesma armadilha do `static`,
# e ela some do radar porque o sintoma é 404 em arquivo que existe no repo. Foi
# o que aconteceu com os ícones: o `<head>` declarava os seis e todos davam 404.
COPY --from=build /app/apps/web-internal/public ./apps/web-internal/public
# `conteudo/` também não entra sozinho, e o modo de falha é o mesmo do `public/`:
# 500 num documento que existe no repo. A rota que o serve devolve 500 com a causa
# em vez de 404, justamente para essa falta aparecer.
COPY --from=build /app/apps/web-internal/conteudo ./apps/web-internal/conteudo
USER node
EXPOSE 3000
CMD ["node", "apps/web-internal/server.js"]

# ─── superfície do cliente ─────────────────────────────────────────────────
FROM base AS web-portal
# HOSTNAME=0.0.0.0 é OBRIGATÓRIO, e a razão é sutil: o servidor standalone do Next
# usa `process.env.HOSTNAME` como endereço de bind, e o Docker define essa variável
# com o ID do contêiner. O ID resolve para o IP da rede PRIMÁRIA — então, num
# contêiner ligado a duas redes, o Next escuta em uma e recusa conexão na outra.
#
# Foi exatamente o que aconteceu: o app respondia 200 pela `pulse-net` e devolvia
# "connection refused" ao NPM, que chega pela `proxy-net`. O sintoma final seria um
# 502 Bad Gateway sem causa aparente — o contêiner de pé, o log limpo, e a porta
# aberta quando testada de dentro da rede errada.
ENV NODE_ENV=production TZ=UTC PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/apps/web-portal/.next/standalone ./
COPY --from=build /app/apps/web-portal/.next/static ./apps/web-portal/.next/static
USER node
EXPOSE 3000
CMD ["node", "apps/web-portal/server.js"]
