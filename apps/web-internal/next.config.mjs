import { cabecalhosDeSeguranca } from '@pulse/ui/cabecalhos'

/** @type {import('next').NextConfig} */
export default {
  output: 'standalone',
  // Pacotes do monorepo são compilados junto: evita publicar build intermediário.
  transpilePackages: ['@pulse/ui', '@pulse/metrics', '@pulse/auth', '@pulse/db', '@pulse/config'],
  poweredByHeader: false,
  experimental: {
    // Habilita unauthorized() e forbidden(). Sem isso, falha de autenticação vira
    // 500 — e 500 esperado em toda requisição anônima esconde o 500 de verdade
    // no monitoramento de erro.
    authInterrupts: true,
  },
  async headers() {
    // A superfície interna não é embutível em lugar nenhum: ela não tem caso de uso
    // dentro de iframe, e permitir `SAMEORIGIN` já bastaria para clickjacking se um
    // dia alguém servir HTML de usuário no mesmo domínio.
    return [{ source: '/:caminho*', headers: cabecalhosDeSeguranca({ frameAncestors: ["'none'"] }) }]
  },
}
