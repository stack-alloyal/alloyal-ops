import '@ops/ui/estilo.css'

import type { ReactNode } from 'react'

export const metadata = { title: 'Seu clube Alloyal', description: 'Resultados do seu clube' }

/**
 * Superfície do cliente.
 *
 * Aplicação SEPARADA da interna de propósito (ADR-011 + ADR-017): domínio
 * próprio, cabeçalhos de segurança próprios, e — o que mais importa — conexão ao
 * banco com o papel `ops_portal`, que só alcança `public_v` e está sob RLS.
 *
 * Assim o isolamento de tenant é um limite de DEPLOY, não de módulo: não existe
 * import errado capaz de fazer esta aplicação ler `core` ou `metrics`.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  )
}
