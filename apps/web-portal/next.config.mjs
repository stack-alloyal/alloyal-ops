/** @type {import('next').NextConfig} */
export default {
  output: 'standalone',
  // Pacotes do monorepo são compilados junto: evita publicar build intermediário.
  transpilePackages: ['@ops/ui', '@ops/metrics', '@ops/auth', '@ops/db'],
  poweredByHeader: false,
}
