'use client'

import { cn } from '@ops/ui'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { MENU, itemAtivo } from './menu'

/**
 * A navegação da sidebar — o único componente de cliente da casca.
 *
 * É cliente porque precisa do `pathname` para destacar o item ativo, e o
 * pathname não chega ao layout do App Router. Uma nav sem indicação de onde
 * você está é a economia errada: são ~1 kB de JS contra a pergunta "em que tela
 * eu estou" toda vez que alguém volta de uma aba.
 *
 * Mesma pintura do NavLink do alloyal-publi: `bg-purple-50 text-purple-700`
 * no ativo, ícone em roxo, o resto em `ink-2`.
 */
export function Nav({ variante = 'lateral' }: { variante?: 'lateral' | 'topo' }) {
  const pathname = usePathname()
  const ativo = itemAtivo(pathname)?.href

  if (variante === 'topo') {
    return (
      <div className="flex gap-1 overflow-x-auto border-b border-line bg-surface px-4 py-2 md:hidden">
        {MENU.map((m) => (
          <Link
            key={m.href}
            href={m.href}
            className={cn(
              'whitespace-nowrap rounded-sm px-2.5 py-1.5 text-[12.5px] font-semibold',
              m.href === ativo ? 'bg-purple-50 text-purple-700' : 'text-ink-2',
            )}
          >
            {m.rotulo}
          </Link>
        ))}
      </div>
    )
  }

  return (
    <nav className="flex flex-col gap-0.5">
      {MENU.map((m) => {
        const Icone = m.icone
        const isAtivo = m.href === ativo
        return (
          <Link
            key={m.href}
            href={m.href}
            aria-current={isAtivo ? 'page' : undefined}
            className={cn(
              'flex items-center gap-[11px] rounded-sm px-[10px] py-[9px] text-[13.5px] font-semibold transition-colors',
              isAtivo ? 'bg-purple-50 text-purple-700' : 'text-ink-2 hover:bg-surface-2',
            )}
          >
            <Icone
              className={cn('h-[17px] w-[17px] shrink-0', isAtivo ? 'text-purple-500' : 'text-ink-3')}
            />
            <span className="truncate">{m.rotulo}</span>
          </Link>
        )
      })}
    </nav>
  )
}
