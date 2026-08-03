import type { Identidade } from '@pulse/auth'
import { LogOut, ShieldCheck, Users } from 'lucide-react'
import Link from 'next/link'

/**
 * O perfil no header, portado do `user-menu.tsx` do Publi.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ SEM JAVASCRIPT, e é decisão de arquitetura desta casca.                    │
 * │                                                                            │
 * │ O do Publi usa o DropdownMenu do Radix, que é componente de cliente. A      │
 * │ `casca.tsx` diz, em comentário, que a `Nav` é o ÚNICO componente de cliente │
 * │ aqui — e o motivo é o mesmo que tirou o `<a>` do `BotaoGoogle` quando ele    │
 * │ era `'use client'`: o Next serializa como referência lazy e o conteúdo só    │
 * │ existe depois de hidratar.                                                  │
 * │                                                                            │
 * │ `<details>`/`<summary>` dá o mesmo comportamento — abre no clique, fecha no │
 * │ Escape, navegável por teclado — em HTML puro. O menu, inclusive o link de   │
 * │ SAIR, está no HTML da resposta.                                            │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Mostra os papéis TODOS, e não um só. O Publi tem um papel por pessoa; aqui a
 * permissão é a UNIÃO de vários, e mostrar apenas o primeiro faria alguém estimar
 * errado o próprio acesso.
 */

/**
 * Iniciais a partir do nome; do e-mail quando não há nome.
 *
 * Exportada porque é pura e tem um caso que engana: `nome` com uma palavra só
 * deve dar UMA letra, não duplicar. `initials` do Publi faz
 * `p[0][0] + p[p.length-1][0]`, que em "Ana" devolve "AA".
 */
export function iniciais(nome: string | null, email: string): string {
  const base = (nome ?? '').trim()
  if (base) {
    const partes = base.split(/\s+/).filter(Boolean)
    const primeira = partes[0]?.[0] ?? ''
    const ultima = partes.length > 1 ? (partes[partes.length - 1]?.[0] ?? '') : ''
    return (primeira + ultima).toUpperCase()
  }
  return (email.trim()[0] ?? '?').toUpperCase()
}

/** Primeiro nome, ou a parte local do e-mail. Nunca o e-mail inteiro no header. */
export function tratamento(nome: string | null, email: string): string {
  const base = (nome ?? '').trim()
  if (base) return base.split(/\s+/)[0] ?? base
  return email.split('@')[0] ?? email
}

export function Perfil({ id, nome }: { id: Identidade; nome: string | null }) {
  const podeConfigurar = id.permissoes.configurar
  return (
    <details className="relative [&[open]>summary>svg]:rotate-180">
      <summary className="flex cursor-pointer list-none items-center gap-2 rounded-full py-1 pl-1 pr-2 outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-purple-100">
        <span
          className="grid h-[30px] w-[30px] shrink-0 place-items-center rounded-full bg-purple-50 text-[11.5px] font-semibold text-purple-700"
          aria-hidden="true"
        >
          {iniciais(nome, id.email)}
        </span>
        <span className="hidden max-w-[140px] truncate text-[13px] font-medium text-ink sm:inline">
          {tratamento(nome, id.email)}
        </span>
      </summary>

      {/* `z-40`: acima do header, que é `z-30`. */}
      <div className="absolute right-0 z-40 mt-2 w-[268px] overflow-hidden rounded-lg border border-line bg-surface shadow-pop">
        <div className="border-b border-line px-4 py-3">
          <div className="truncate text-[13.5px] font-semibold text-ink">
            {nome ?? tratamento(nome, id.email)}
          </div>
          <div className="mt-0.5 truncate text-[12px] text-ink-3">{id.email}</div>
          <div className="mt-2 flex flex-wrap gap-1">
            {id.papeis.map((p) => (
              <span
                key={p}
                className="rounded-full bg-purple-50 px-2 py-0.5 text-[11px] font-medium text-purple-700"
              >
                {p.replace(/^pulse-/, '')}
              </span>
            ))}
          </div>
        </div>

        {podeConfigurar && (
          <div className="border-b border-line py-1">
            <Link
              href="/configuracoes/usuarios"
              className="flex items-center gap-2.5 px-4 py-2 text-[13px] text-ink transition-colors hover:bg-surface-2"
            >
              <Users className="h-4 w-4 text-ink-3" />
              Gerenciar usuários
            </Link>
            <Link
              href="/configuracoes/papeis"
              className="flex items-center gap-2.5 px-4 py-2 text-[13px] text-ink transition-colors hover:bg-surface-2"
            >
              <ShieldCheck className="h-4 w-4 text-ink-3" />
              Matriz de permissões
            </Link>
          </div>
        )}

        {/* `<a>` e não `<Link>`: sair é navegação de DOCUMENTO para uma rota do
            oauth2-proxy, que o roteador do Next não conhece. Com `<Link>` o Next
            tentaria buscar como rota da aplicação e a pessoa não sairia. */}
        <a
          href="/oauth2/sign_out?rd=/"
          className="flex items-center gap-2.5 px-4 py-2.5 text-[13px] text-red transition-colors hover:bg-red-50"
        >
          <LogOut className="h-4 w-4" />
          Sair
        </a>
      </div>
    </details>
  )
}
