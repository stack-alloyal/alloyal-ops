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
    // O corpo de uma Server Action é limitado a 1 MB por padrão, e é o print de
    // tela que estoura isso primeiro — justamente o anexo que mais ajuda a
    // entender um bug. O erro sairia depois de a pessoa já ter escrito o relato
    // inteiro. 25 MB é a mesma folga que o Metas usa para o mesmo painel; o
    // limite que vale de verdade é o do Radar (10 MB por arquivo), conferido
    // antes do envio em `app/(interno)/radar/`.
    serverActions: { bodySizeLimit: '25mb' },
  },
  async headers() {
    // A superfície interna não é embutível em lugar nenhum: ela não tem caso de uso
    // dentro de iframe, e permitir `SAMEORIGIN` já bastaria para clickjacking se um
    // dia alguém servir HTML de usuário no mesmo domínio.
    return [{ source: '/:caminho*', headers: cabecalhosDeSeguranca({ frameAncestors: ["'none'"] }) }]
  },
}
