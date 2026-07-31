import '@ops/ui/estilo.css'

import type { ReactNode } from 'react'

import { Casca } from './casca'

export const metadata = { title: 'Alloyal Ops', description: 'Ferramentas de operação' }

/**
 * Layout raiz da superfície interna.
 *
 * Existe como layout de GRUPO, e não como layout único da aplicação, porque a página
 * de impressão do relatório precisa de uma raiz sem casca: o que sai no PDF é o que o
 * cliente lê, e um menu de navegação interna impresso ali seria operação nossa
 * escapando para fora. O Next permite mais de um layout raiz exatamente para isto —
 * cada grupo declara o próprio `html`.
 *
 * Autenticação NÃO acontece aqui: o oauth2-proxy à frente do Nginx Proxy Manager já
 * barrou quem não é @alloyal.com.br (ADR-016). Esta camada resolve papel.
 */
export default function LayoutInterno({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        <Casca>{children}</Casca>
      </body>
    </html>
  )
}
