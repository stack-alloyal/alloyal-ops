/** @type {import('next').NextConfig} */
export default {
  output: 'standalone',
  // Pacotes do monorepo são compilados junto: evita publicar build intermediário.
  transpilePackages: ['@ops/ui', '@ops/metrics', '@ops/auth', '@ops/db'],
  poweredByHeader: false,
  experimental: {
    // Habilita unauthorized() e forbidden(). Sem isso, falha de autenticação vira
    // 500 — e 500 esperado em toda requisição anônima esconde o 500 de verdade
    // no monitoramento de erro.
    authInterrupts: true,
  },
}
