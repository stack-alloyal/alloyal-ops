import { AlloyalLogo, cn } from '@pulse/ui'
import { BarChart3 } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'

import { nomeDaPessoa } from '@pulse/config'

import { itemAtivo } from './menu'
import { Nav } from './nav'
import { Perfil } from './perfil'
import { NovidadesDoRadar } from './radar/novidades'
import { PainelDoRadar } from './radar/painel'
import { pool } from '../../lib/db'
import { identidadeDaSessao } from '../../lib/guarda'

/**
 * Sidebar e topbar — a casca do Publi, portada.
 *
 * Duas diferenças deliberadas em relação ao alloyal-publi:
 *
 *  1. Não há colapso nem drawer mobile. Aquilo depende de estado de cliente, e
 *     esta casca é Server Component inteira. O menu do Pulse tem seis itens; o do
 *     Publi tem projetos aninhados, que é o que torna o colapso necessário lá.
 *
 *  2. A nav é o único componente de cliente (`nav.tsx`), porque precisa do
 *     pathname para destacar o item ativo. Mesma pintura do NavLink do Publi.
 *
 * As medidas são as do Publi: 252 px de sidebar, 62 px de topbar, logo de 24 px.
 * Elas estão em `--sidebar-w` e `--topbar-h` para não divergirem por engano.
 */

export function Casca({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-[252px] shrink-0 flex-col border-r border-line bg-surface px-[14px] py-[18px] md:flex">
        <div className="px-2 pb-[18px] pt-1.5">
          <Link href="/" aria-label="Início">
            <AlloyalLogo className="h-6" />
          </Link>
        </div>
        <Nav />
        <div className="mt-auto px-2 pt-4 text-[11px] leading-relaxed text-ink-4">
          Alloyal Pulse · ferramentas de operação
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  )
}

/**
 * Topbar da página, com o nome e o propósito da tela.
 *
 * Cada página monta a sua: é o que permite o destaque do item ativo e o subtítulo
 * correto sem estado de cliente. O `proposito` não é enfeite — é a frase que
 * responde "o que esta tela decide", e telas de operação sem essa frase viram
 * painéis que ninguém sabe para que abre.
 *
 * O PERFIL é resolvido AQUI, e não passado por `acoes`. São 16 telas usando este
 * componente: pedir a cada uma que monte o próprio perfil garantiria que alguma
 * esquecesse, e o sintoma seria uma tela sem como sair.
 *
 * Por isso o componente é `async`: ele lê a identidade. Só renderiza em tela já
 * autenticada — a página chamou `exigir` antes —, então a leitura não pode falhar
 * por falta de sessão.
 */
export async function Topo({
  href,
  titulo,
  proposito,
  acoes,
  icone,
}: {
  href: string
  titulo?: string
  proposito?: string
  acoes?: ReactNode
  /** Para telas fora do menu, como a ficha de uma conta. */
  icone?: typeof BarChart3
}) {
  const item = itemAtivo(href)
  const Icone = icone ?? item?.icone ?? BarChart3
  const eu = await identidadeDaSessao()
  const nome = await nomeDaPessoa(pool(), eu.email)
  return (
    <>
      <header className="sticky top-0 z-30 flex h-[62px] shrink-0 items-center gap-3 border-b border-line bg-surface px-4 md:px-7">
        <div className="md:hidden">
          <AlloyalLogo className="h-6" />
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <Icone className="h-[18px] w-[18px] shrink-0 text-purple-500" />
          <span className="truncate text-title text-ink">{titulo ?? item?.rotulo}</span>
          {(proposito ?? item?.proposito) && (
            <span className="hidden truncate text-[13px] text-ink-3 lg:inline">
              · {proposito ?? item?.proposito}
            </span>
          )}
        </div>
        <div className="flex-1" />
        {acoes}
        {/* Radar: reportar (🐛) e novidades (✨). Ficam AQUI pelo mesmo motivo do
            Perfil — são 16 telas, e pedir que cada uma monte os próprios garantiria
            que alguma esquecesse. A tela onde a pessoa esbarra no defeito é
            justamente a que não pode ser a esquecida. */}
        <NovidadesDoRadar />
        <PainelDoRadar />
        <Perfil id={eu} nome={nome} />
      </header>
      {/* Menu horizontal no mobile, onde a sidebar não aparece. */}
      <Nav variante="topo" />
    </>
  )
}

/** O corpo da página, com a largura e o respiro do Publi. */
export function Corpo({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <main className={cn('mx-auto w-full max-w-[1180px] px-4 py-6 md:px-7 md:py-7', className)}>
      {children}
    </main>
  )
}
