import { cn } from '@pulse/ui'
import {
  KeyRound,
  RefreshCw,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  Users,
} from 'lucide-react'
import Link from 'next/link'

/**
 * Submenu de Configurações, no padrão do Allvoice.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ FONTE ÚNICA, como o `CONFIG_SUB_ITEMS` do Allvoice                          │
 * │ (`alloyal-chat/src/screens/config-nav.ts`).                                │
 * │                                                                            │
 * │ Antes, cada tela de configuração montava a própria fileira de atalhos no    │
 * │ `acoes` do topo. Eram quatro listas parciais e nenhuma completa: a tela de  │
 * │ Papéis oferecia voltar para Configurações, a de Segredos oferecia outra     │
 * │ coisa, e nenhuma levava para a irmã. Lista duplicada diverge — é a mesma    │
 * │ regra que obrigou `papeis.test.ts` e `testes-no-ci.test.mjs` a existirem.   │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Server Component, e o item ativo vem do `atual` que a página passa — não do
 * `usePathname`. A `casca.tsx` diz que a `Nav` é o único componente de cliente
 * daqui, e o motivo é o de sempre: conteúdo que só existe depois de hidratar.
 */

export interface ItemDeConfiguracao {
  readonly href: string
  readonly rotulo: string
  readonly resumo: string
  readonly icone: typeof Users
}

export const ITENS_DE_CONFIGURACAO: readonly ItemDeConfiguracao[] = [
  {
    href: '/configuracoes',
    rotulo: 'Ajustes',
    resumo: 'os números que a operação muda sem chamar o dev',
    icone: SlidersHorizontal,
  },
  {
    href: '/configuracoes/usuarios',
    rotulo: 'Usuários',
    resumo: 'quem existe, e quem está com acesso ativo',
    icone: Users,
  },
  {
    href: '/configuracoes/papeis',
    rotulo: 'Papéis',
    resumo: 'quem vê o quê, e desde quando',
    icone: ShieldCheck,
  },
  {
    href: '/configuracoes/sincronizacao',
    rotulo: 'Sincronização',
    resumo: 'os ciclos, a agenda e o histórico de cada carga',
    icone: RefreshCw,
  },
  {
    href: '/configuracoes/segredos',
    rotulo: 'Segredos',
    resumo: 'token e chave de acesso, cifrados',
    icone: KeyRound,
  },
  {
    href: '/configuracoes/historico',
    rotulo: 'Histórico',
    resumo: 'toda mudança de configuração, com motivo',
    icone: ScrollText,
  },
]

export function itemDeConfiguracao(href: string): ItemDeConfiguracao | undefined {
  return ITENS_DE_CONFIGURACAO.find((i) => i.href === href)
}

/**
 * O submenu. `atual` é a rota exata, e não prefixo: `/configuracoes` é prefixo de
 * todas as outras, e comparar por prefixo destacaria "Ajustes" em toda tela.
 */
export function SubmenuDeConfiguracao({ atual }: { atual: string }) {
  return (
    <nav
      aria-label="Seções de configuração"
      className="flex gap-1 overflow-x-auto border-b border-line pb-3 lg:sticky lg:top-[62px] lg:h-fit lg:w-[212px] lg:shrink-0 lg:flex-col lg:overflow-visible lg:border-b-0 lg:border-r lg:pb-0 lg:pr-3"
    >
      {ITENS_DE_CONFIGURACAO.map((i) => {
        const ativo = i.href === atual
        const Icone = i.icone
        return (
          <Link
            key={i.href}
            href={i.href}
            aria-current={ativo ? 'page' : undefined}
            className={cn(
              'flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-[13px] transition-colors',
              ativo
                ? 'bg-purple-50 font-semibold text-purple-700'
                : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
            )}
          >
            <Icone className={cn('h-4 w-4 shrink-0', ativo ? 'text-purple-500' : 'text-ink-4')} />
            {i.rotulo}
          </Link>
        )
      })}
    </nav>
  )
}

/**
 * Casca das telas de configuração: submenu à esquerda, conteúdo à direita.
 *
 * Em telas estreitas o submenu vira fileira rolável no topo — a sidebar principal
 * também desaparece ali, e duas listas verticais empilhadas empurrariam o conteúdo
 * para fora da primeira dobra.
 */
export function CorpoDeConfiguracao({
  atual,
  children,
}: {
  atual: string
  children: React.ReactNode
}) {
  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-5 px-4 py-6 md:px-7 md:py-7 lg:flex-row lg:gap-7">
      <SubmenuDeConfiguracao atual={atual} />
      <div className="grid min-w-0 flex-1 gap-5">{children}</div>
    </div>
  )
}
