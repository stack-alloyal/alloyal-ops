import '@ops/ui/tokens.css'
import '@ops/ui/app.css'

import type { ReactNode } from 'react'

export const metadata = { title: 'Alloyal Ops', description: 'Ferramentas de operação' }

/**
 * Casca do Alloyal Ops.
 *
 * Doc 00, seção 1: uma pessoa faz login uma vez, vê uma casca, e as ferramentas
 * são módulos dentro dela. Success é a primeira; as próximas entram como rotas,
 * não como produtos novos com login próprio.
 *
 * Autenticação NÃO acontece aqui: o oauth2-proxy à frente do Nginx Proxy Manager
 * já barrou quem não é @alloyal.com.br (ADR-016). Esta camada resolve papel.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        <header className="ops-shell__header">
          <strong>Alloyal Ops</strong>
          <nav aria-label="Ferramentas">
            <a href="/">Minha fila</a>
            <a href="/gatilhos">Gatilhos</a>
            <a href="/dados">Dados</a>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  )
}
