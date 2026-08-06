'use client'

import { Btn } from '@pulse/ui'
import { X, type Bug } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'

/**
 * A gaveta lateral direita — a casca compartilhada dos dois painéis do Radar.
 *
 * Existe porque reportar e novidades precisam da MESMA gaveta, e as duas cópias
 * já tinham divergido no produto de onde isto foi portado: uma fechava no Esc, a
 * outra não; uma travava a rolagem do fundo, a outra deixava a página correr
 * atrás do painel. São defeitos que ninguém abre um chamado para relatar e que
 * também não aparecem em revisão — cada arquivo parece certo sozinho.
 *
 * É componente de CLIENTE, e é a segunda exceção da casca (a `Nav` é a primeira).
 * O motivo é diferente do dela: aqui o conteúdo vem de um sistema de fora, sob
 * clique, e não existe versão sem JavaScript que não custe uma navegação de
 * página inteira para ler três linhas de novidade.
 */
export function Gaveta({
  titulo,
  legenda,
  icone: Icone,
  aberta,
  aoFechar,
  acoes,
  children,
}: {
  titulo: string
  legenda?: string
  icone: typeof Bug
  aberta: boolean
  aoFechar: () => void
  /** Botões do cabeçalho, à direita do título. */
  acoes?: ReactNode
  children: ReactNode
}) {
  useEffect(() => {
    if (!aberta) return
    const noTeclado = (e: KeyboardEvent) => {
      if (e.key === 'Escape') aoFechar()
    }
    window.addEventListener('keydown', noTeclado)
    // Trava a rolagem do fundo: sem isto a página corre atrás da gaveta e a
    // pessoa perde o lugar onde estava ao fechar.
    const antes = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', noTeclado)
      document.body.style.overflow = antes
    }
  }, [aberta, aoFechar])

  if (!aberta) return null

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label={titulo}>
      {/* O fundo escuro fecha ao clique — o gesto que todo mundo tenta primeiro. */}
      <div className="absolute inset-0 bg-ink/40" onClick={aoFechar} />

      <aside className="absolute right-0 top-0 flex h-full w-full max-w-lg flex-col bg-surface shadow-pop">
        <header className="flex items-center gap-2 border-b border-line px-5 py-4">
          <Icone className="h-[18px] w-[18px] shrink-0 text-purple-500" />
          <h2 className="text-title text-ink">{titulo}</h2>
          {legenda && <span className="hidden text-[12px] text-ink-3 sm:inline">· {legenda}</span>}
          <div className="ml-auto flex items-center gap-1.5">
            {acoes}
            <Btn variant="ghost" onClick={aoFechar} title="Fechar" className="h-8 w-8 border-0 px-0">
              <X className="h-4 w-4" />
            </Btn>
          </div>
        </header>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </aside>
    </div>
  )
}
