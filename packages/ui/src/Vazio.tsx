import Link from 'next/link'

import { cn } from './base'

/**
 * Estado vazio que ENSINA (requisito D5).
 *
 * "Nenhum item na fila" com uma ilustração e ponto final é a forma mais barata
 * de fazer alguém achar que a ferramenta está quebrada. Todo vazio diz três
 * coisas: o que aconteceu, por que, e o que fazer agora.
 */
export interface VazioProps {
  readonly titulo: string
  readonly porque: string
  readonly acao?: { readonly texto: string; readonly href: string }
  readonly className?: string
}

export function Vazio({ titulo, porque, acao, className }: VazioProps) {
  return (
    <div
      role="status"
      className={cn(
        'max-w-[70ch] rounded-lg border border-dashed border-line-strong bg-surface p-6',
        className,
      )}
    >
      <p className="text-[14px] font-bold tracking-[-0.01em] text-ink">{titulo}</p>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{porque}</p>
      {acao ? (
        <Link
          href={acao.href}
          className="mt-3 inline-block text-[13px] font-semibold text-purple-700 hover:text-purple-500"
        >
          {acao.texto} →
        </Link>
      ) : null}
    </div>
  )
}
