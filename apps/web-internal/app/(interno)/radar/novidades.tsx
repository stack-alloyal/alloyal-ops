'use client'

import { Btn } from '@pulse/ui'
import { Check, CheckCheck, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { novidadesDoRadar } from './acoes'
import { Gaveta } from './gaveta'
import { CONTROLE_DE_TOPO, ContadorDoTopo } from '../botao-de-topo'
import type { Novidade } from '../../../lib/radar'

/**
 * ✨ O que há de novo — as notas de release do Pulse publicadas no Radar.
 *
 * Três camadas, iguais às do Publi: o MENU na topbar com as últimas oito, a
 * GAVETA com tudo agrupado por dia, e o AVISO automático quando chega novidade
 * que esta pessoa ainda não viu.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ O menu é `<details>`, e não o DropdownMenu do Radix como no Publi.         │
 * │                                                                            │
 * │ Não é escassez de biblioteca: é a mesma decisão do `perfil.tsx`, que já    │
 * │ resolveu este problema aqui. Radix é componente de cliente e traria a      │
 * │ dependência inteira para dentro da casca por causa de um menu de oito      │
 * │ linhas. `<details>`/`<summary>` abre no clique e é navegável por teclado   │
 * │ em HTML puro.                                                             │
 * │                                                                            │
 * │ O que o `<details>` NÃO faz sozinho é fechar — nem no clique fora, nem no  │
 * │ Escape. O Radix faz, e um menu que só fecha clicando no próprio ícone      │
 * │ parece travado. Como este componente já é de cliente (o conteúdo vem de    │
 * │ um fetch), os dois gestos são ligados na mão, abaixo. O `perfil.tsx` não   │
 * │ tem esse laço porque ali o menu precisa existir sem JavaScript nenhum.     │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ O ESTADO DE LIDA É DO NAVEGADOR, e isso é escolha, não atalho.            │
 * │                                                                            │
 * │ Guardar no banco exigiria uma tabela por pessoa por nota, migration e      │
 * │ escrita a cada abertura de tela — para uma informação que não vale nada    │
 * │ fora deste navegador e que ninguém audita. O custo de errar é reler uma    │
 * │ novidade em outra máquina.                                                 │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * O aviso automático só aparece quando há nota NÃO LIDA e MAIS NOVA que a
 * última já anunciada. Sem a segunda condição ele reabriria a cada navegação
 * até a pessoa marcar tudo — que é como um aviso de novidade vira algo que se
 * fecha sem ler.
 */

const LIDAS = 'radar:novidades:lidas'
const ANUNCIADAS = 'radar:novidades:anunciadas'

const EMOJI_DO_TIPO: Record<string, string> = { bug: '🐛', melhoria: '⚡', feature: '✨' }

/** Quantas cabem no menu. O resto está a um clique, na gaveta. */
const NO_MENU = 8

function lerLidas(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(LIDAS) ?? '[]') as string[])
  } catch {
    // Chave adulterada ou de uma versão antiga do formato: começar do zero é
    // melhor que quebrar o ✨ para sempre neste navegador.
    return new Set()
  }
}

function fmtDia(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  })
}

export function NovidadesDoRadar() {
  const [itens, setItens] = useState<Novidade[]>([])
  const [lidas, setLidas] = useState<Set<string>>(new Set())
  const [carregado, setCarregado] = useState(false)
  const [gaveta, setGaveta] = useState(false)
  const [aviso, setAviso] = useState(false)

  const menu = useRef<HTMLDetailsElement>(null)
  const fecharMenu = useCallback(() => {
    if (menu.current) menu.current.open = false
  }, [])

  useEffect(() => {
    const jaLidas = lerLidas()
    setLidas(jaLidas)
    novidadesDoRadar()
      .then((lista) => {
        setItens(lista)
        const naoLidas = lista.filter((n) => !jaLidas.has(n.id))
        if (naoLidas.length === 0) return
        const maisNova = Math.max(...naoLidas.map((n) => +new Date(n.publicadoEm)))
        if (maisNova > Number(localStorage.getItem(ANUNCIADAS) ?? 0)) setAviso(true)
      })
      .finally(() => setCarregado(true))
  }, [])

  // O que o Radix daria de graça: clique fora e Escape fecham o menu.
  useEffect(() => {
    const noClique = (e: MouseEvent) => {
      const d = menu.current
      if (d?.open && e.target instanceof Node && !d.contains(e.target)) d.open = false
    }
    const noTeclado = (e: KeyboardEvent) => {
      if (e.key === 'Escape') fecharMenu()
    }
    document.addEventListener('click', noClique)
    window.addEventListener('keydown', noTeclado)
    return () => {
      document.removeEventListener('click', noClique)
      window.removeEventListener('keydown', noTeclado)
    }
  }, [fecharMenu])

  const naoLidas = useMemo(() => itens.filter((n) => !lidas.has(n.id)), [itens, lidas])

  const marcarLida = useCallback((id: string) => {
    setLidas((antes) => {
      const s = new Set(antes)
      s.add(id)
      localStorage.setItem(LIDAS, JSON.stringify([...s]))
      return s
    })
  }, [])

  const marcarTodas = useCallback(() => {
    setLidas(() => {
      const s = new Set(itens.map((n) => n.id))
      localStorage.setItem(LIDAS, JSON.stringify([...s]))
      return s
    })
  }, [itens])

  const fecharAviso = useCallback(
    (tambemMarcar: boolean) => {
      if (itens.length > 0) {
        localStorage.setItem(
          ANUNCIADAS,
          String(Math.max(...itens.map((n) => +new Date(n.publicadoEm)))),
        )
      }
      if (tambemMarcar) marcarTodas()
      setAviso(false)
    },
    [itens, marcarTodas],
  )

  useEffect(() => {
    if (!aviso) return
    const noTeclado = (e: KeyboardEvent) => {
      if (e.key === 'Escape') fecharAviso(false)
    }
    window.addEventListener('keydown', noTeclado)
    return () => window.removeEventListener('keydown', noTeclado)
  }, [aviso, fecharAviso])

  const abrirGaveta = useCallback(() => {
    fecharMenu()
    setGaveta(true)
  }, [fecharMenu])

  /** `compacto` esconde a data: no menu, oito datas repetidas viram ruído. */
  const Nota = ({ n, compacto }: { n: Novidade; compacto?: boolean }) => {
    const naoLida = !lidas.has(n.id)
    return (
      <div
        className={`flex gap-2 rounded-md px-2 py-2.5 text-[13px] leading-snug ${naoLida ? 'bg-purple-50' : ''}`}
      >
        <span className="shrink-0">{EMOJI_DO_TIPO[n.tipo] ?? '•'}</span>
        <div className="min-w-0 flex-1">
          <p className={naoLida ? 'font-medium text-ink' : 'text-ink-2'}>{n.notaDeRelease}</p>
          {!compacto && <p className="mt-0.5 text-[11px] text-ink-3">{fmtDia(n.publicadoEm)}</p>}
        </div>
        {naoLida && (
          <Btn
            variant="ghost"
            title="Marcar como lida"
            onClick={() => marcarLida(n.id)}
            className="mt-0.5 h-6 w-6 shrink-0 border-0 bg-transparent px-0 text-purple-700 hover:bg-purple-100 [&_svg]:size-[14px]"
          >
            <Check />
          </Btn>
        )}
      </div>
    )
  }

  const porDia = itens.reduce<Record<string, Novidade[]>>((acc, n) => {
    const chave = fmtDia(n.publicadoEm)
    ;(acc[chave] ??= []).push(n)
    return acc
  }, {})

  return (
    <>
      {/* O ✨ fica na topbar SEMPRE, com novidade ou sem — é o padrão do Publi, e
          é o que faz dele um lugar conhecido para procurar em vez de um ícone que
          aparece e some. */}
      <details ref={menu} className="relative">
        <summary title="O que há de novo no Pulse" className={CONTROLE_DE_TOPO}>
          <Sparkles />
          <ContadorDoTopo valor={naoLidas.length} />
        </summary>

        {/* `z-40`: acima do header, que é `z-30` — a mesma medida do menu do perfil,
            e por isso a mesma casca (borda, raio e sombra) também. */}
        <div className="absolute right-0 z-40 mt-2 w-96 overflow-hidden rounded-lg border border-line bg-surface p-1 shadow-pop">
          <div className="flex items-center px-2 py-1.5 text-sm font-semibold text-ink">
            O que há de novo no Pulse
            {naoLidas.length > 0 && (
              <Btn
                variant="ghost"
                onClick={marcarTodas}
                title="Marcar todas como lidas"
                className="ml-auto h-auto gap-1 border-0 bg-transparent px-0 text-[11.5px] font-medium text-purple-700 hover:bg-transparent hover:underline [&_svg]:size-[14px]"
              >
                <CheckCheck /> marcar todas
              </Btn>
            )}
          </div>

          <div className="-mx-1 my-1 h-px bg-line" />

          {!carregado ? (
            <div className="px-2 py-3 text-[12.5px] text-ink-3">Carregando…</div>
          ) : itens.length === 0 ? (
            <div className="px-2 py-3 text-[12.5px] text-ink-3">
              Nenhuma novidade publicada ainda.
            </div>
          ) : (
            <div className="max-h-96 overflow-y-auto">
              {itens.slice(0, NO_MENU).map((n) => (
                <Nota key={n.id} n={n} compacto />
              ))}
            </div>
          )}

          <div className="-mx-1 my-1 h-px bg-line" />

          <Btn
            variant="ghost"
            onClick={abrirGaveta}
            className="h-auto w-full justify-start border-0 bg-transparent px-2 py-2 text-[12.5px] font-medium text-purple-700 hover:bg-transparent hover:underline"
          >
            Ver todas as novidades →
          </Btn>
        </div>
      </details>

      <Gaveta
        titulo="Novidades · Pulse"
        icone={Sparkles}
        aberta={gaveta}
        aoFechar={() => setGaveta(false)}
        acoes={
          naoLidas.length > 0 ? (
            <Btn
              variant="ghost"
              onClick={marcarTodas}
              className="h-8 border-0 px-2 text-[12px] text-purple-700 [&_svg]:size-[14px]"
            >
              <CheckCheck /> marcar todas
            </Btn>
          ) : undefined
        }
      >
        <div className="px-5 py-4">
          {itens.length === 0 && (
            <p className="py-6 text-center text-[13px] text-ink-3">
              Nenhuma novidade publicada ainda.
            </p>
          )}
          {Object.entries(porDia).map(([quando, lista]) => (
            <section key={quando} className="mb-5">
              <h3 className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">
                {quando}
              </h3>
              <div className="flex flex-col gap-1.5">
                {lista.map((n) => (
                  <Nota key={n.id} n={n} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </Gaveta>

      {aviso && naoLidas.length > 0 && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Novidades no Pulse"
        >
          <div className="absolute inset-0 bg-ink/50" onClick={() => fecharAviso(false)} />
          <div className="relative w-full max-w-md rounded-lg bg-surface p-5 shadow-pop">
            <div className="mb-3 flex items-center gap-2">
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-purple-50 text-purple-700">
                <Sparkles className="h-[18px] w-[18px]" />
              </span>
              <div>
                <h2 className="text-title text-ink">Novidades no Pulse</h2>
                <p className="text-[12.5px] text-ink-3">
                  {naoLidas.length === 1
                    ? '1 atualização nova'
                    : `${naoLidas.length} atualizações novas`}{' '}
                  desde a sua última visita
                </p>
              </div>
            </div>
            <div className="max-h-72 overflow-y-auto">
              {naoLidas.slice(0, 6).map((n) => (
                <Nota key={n.id} n={n} />
              ))}
              {naoLidas.length > 6 && (
                <p className="px-2 py-1 text-[12px] text-ink-3">…e mais {naoLidas.length - 6}.</p>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Btn
                variant="ghost"
                onClick={() => {
                  fecharAviso(false)
                  setGaveta(true)
                }}
              >
                Ver todas
              </Btn>
              <Btn onClick={() => fecharAviso(true)}>Entendi</Btn>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
