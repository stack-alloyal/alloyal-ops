'use client'

import { Btn } from '@pulse/ui'
import type { Bug } from 'lucide-react'

/**
 * O controle de ícone da topbar — o do Publi, portado e num lugar só.
 *
 * No Publi essa medida aparece copiada em quatro componentes (`sidebar-toggle`,
 * `notification-bell`, `whats-new`, `report-drawer`), sempre igual:
 *
 *     h-9 w-9 · rounded-md · text-ink-3 → ink no hover · hover:bg-surface-2 · ícone de 18px
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ AS CLASSES DO ÍCONE NÃO FICAM NO ÍCONE, e o motivo é especificidade.       │
 * │                                                                            │
 * │ A `Btn` traz `[&_svg]:size-[15px]`, que compila para `.classe svg{…}` —    │
 * │ seletor DESCENDENTE, especificidade (0,1,1). Um `h-[18px]` escrito no      │
 * │ próprio `<svg>` é (0,1,0) e PERDE: o ícone sai a 15px, três pixels menor   │
 * │ que o padrão da casa, sem erro nenhum e sem aparecer em revisão de código  │
 * │ — só lado a lado com o Publi.                                             │
 * │                                                                            │
 * │ Por isso o tamanho é declarado aqui, no mesmo eixo do que o atropelava:    │
 * │ `[&_svg]:size-[18px]`. Quem usa não passa classe nenhuma para o ícone.     │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

/**
 * A aparência do controle, exportada como CLASSE e não só como componente.
 *
 * Existe porque nem todo controle de topo pode ser um `<button>`: o ✨ é um
 * `<details>`, e ali quem recebe o clique é o `<summary>` — um `<Btn>` dentro
 * dele engoliria o clique e o menu nunca abriria. Sem esta constante, o
 * `<summary>` precisaria de uma CÓPIA das classes, e cópia de medida diverge no
 * primeiro ajuste (foi assim que o avatar do perfil ficou 6px menor que o resto).
 *
 * `list-none` e o marcador do WebKit vão junto porque só o `<summary>` os usa e
 * não custam nada ao `<button>` — o preço de esquecê-los é uma setinha preta
 * aparecendo ao lado do ícone no Safari.
 */
export const CONTROLE_DE_TOPO =
  'relative flex h-9 w-9 cursor-pointer list-none items-center justify-center rounded-md border-0 bg-transparent px-0 text-ink-3 outline-none transition-colors hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 [&::-webkit-details-marker]:hidden [&_svg]:size-[18px]'

/**
 * A bolinha do canto — a medida do sino de alertas do Publi.
 *
 * Fica DENTRO do controle (o botão ou o `<summary>`), como no Publi, e não ao
 * lado dele: no `<details>`, todo filho que não é o `<summary>` some enquanto o
 * menu está fechado — que é justamente quando a bolinha precisa aparecer.
 */
export function ContadorDoTopo({ valor }: { valor: number }) {
  if (valor <= 0) return null
  return (
    /* `pointer-events-none`: a bolinha fica POR CIMA do controle, e sem isto o
       clique no canto superior direito do ícone não abre nada. */
    <span className="pointer-events-none absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-purple-500 px-1 text-[10px] font-bold leading-none text-white">
      {valor > 9 ? '9+' : valor}
    </span>
  )
}

export function BotaoDeTopo({
  icone: Icone,
  titulo,
  contador = 0,
  aoClicar,
}: {
  icone: typeof Bug
  /** Vira o `title` e, num botão só de ícone, o nome acessível. */
  titulo: string
  contador?: number
  aoClicar: () => void
}) {
  return (
    <Btn variant="ghost" onClick={aoClicar} title={titulo} className={CONTROLE_DE_TOPO}>
      <Icone />
      <ContadorDoTopo valor={contador} />
    </Btn>
  )
}
