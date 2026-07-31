import { cabecalhosDeSeguranca } from '@ops/ui/cabecalhos'

/** @type {import('next').NextConfig} */
export default {
  output: 'standalone',
  // Pacotes do monorepo são compilados junto: evita publicar build intermediário.
  transpilePackages: ['@ops/ui', '@ops/metrics', '@ops/auth', '@ops/db'],
  poweredByHeader: false,
  async headers() {
    // `frame-ancestors 'none'` é BLOQUEANTE no critério §17.3 do PRD. O portal é a
    // única superfície que um cliente acessa autenticado, e é a que um site de
    // terceiro teria motivo para embutir.
    return [{ source: '/:caminho*', headers: cabecalhosDeSeguranca({ frameAncestors: ["'none'"] }) }]
  },
}
