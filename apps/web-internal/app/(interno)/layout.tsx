import '@pulse/ui/estilo.css'

import type { ReactNode } from 'react'

import { Casca } from './casca'
import { autenticado } from '../../lib/guarda'

export const metadata = { title: 'Alloyal Pulse', description: 'Ferramentas de operação' }

/**
 * Layout raiz da superfície interna.
 *
 * Existe como layout de GRUPO, e não como layout único da aplicação, porque a página
 * de impressão do relatório precisa de uma raiz sem casca: o que sai no PDF é o que o
 * cliente lê, e um menu de navegação interna impresso ali seria operação nossa
 * escapando para fora. O Next permite mais de um layout raiz exatamente para isto —
 * cada grupo declara o próprio `html`.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A casca só envolve quem está autenticado, e é aqui que isso se decide.      │
 * │                                                                            │
 * │ `unauthorized.tsx` mora dentro deste grupo, então a tela de login vinha     │
 * │ DENTRO da casca: um visitante não autenticado via a sidebar com o nome de   │
 * │ todas as telas internas, e o painel de login ficava espremido no espaço que │
 * │ sobrava. O HTML da resposta não mostrava o vazamento — a `Nav` é componente │
 * │ de cliente e só materializa ao hidratar. Apareceu na captura de tela.       │
 * │                                                                            │
 * │ `children` é renderizado NOS DOIS casos, e é o que preserva o status: a      │
 * │ primeira tentativa trocava `children` por `<Login/>` direto aqui, a página   │
 * │ deixava de rodar, `unauthorized()` nunca era chamado e a rota protegida      │
 * │ passou a responder **200**. Login com 200 é o que faz monitoramento e        │
 * │ rastreador lerem "deu certo" numa tela que diz "entre".                    │
 * │                                                                            │
 * │ Então: o layout decide o que ENVOLVER, e a página decide o que RESPONDER.   │
 * │ Não autenticado → `unauthorized()` → `unauthorized.tsx` = `<Login/>`, agora  │
 * │ sem casca em volta, com 401.                                               │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * A verificação de PAPEL não acontece aqui: papel é por tela, e cada página resolve
 * com `exigir`. Aqui só se decide se existe alguém do outro lado.
 */
export default async function LayoutInterno({ children }: { children: ReactNode }) {
  const temAlguem = await autenticado()

  return (
    <html lang="pt-BR">
      <body>{temAlguem ? <Casca>{children}</Casca> : children}</body>
    </html>
  )
}
