import '@ops/ui/estilo.css'

import type { ReactNode } from 'react'

import { Casca } from './casca'

export const metadata = { title: 'Alloyal Ops', description: 'Ferramentas de operação' }

/**
 * Casca do Alloyal Ops.
 *
 * Doc 00, seção 1: uma pessoa faz login uma vez, vê uma casca, e as ferramentas
 * são módulos dentro dela. Success é a primeira; as próximas entram como rotas,
 * não como produtos novos com login próprio.
 *
 * O visual é o mesmo do alloyal-publi — sidebar de 252 px, topbar de 62 px,
 * logo laranja, roxo para ação. Quem abre o Ops depois do Publi não deve
 * perceber que trocou de produto.
 *
 * Autenticação NÃO acontece aqui: o oauth2-proxy à frente do Nginx Proxy Manager
 * já barrou quem não é @alloyal.com.br (ADR-016). Esta camada resolve papel.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        <Casca>{children}</Casca>
      </body>
    </html>
  )
}
