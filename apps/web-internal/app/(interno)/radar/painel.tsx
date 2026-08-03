'use client'

import { Aviso, Badge, Btn, Field, Select, TextArea, TOM_POR_FAIXA, type Tom } from '@pulse/ui'
import { Bug, ImagePlus, Paperclip, Plus, RefreshCw, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { reportar, reportsDoRadar } from './acoes'
import { Gaveta } from './gaveta'
import { BotaoDeTopo } from '../botao-de-topo'
import type { Demanda } from '../../../lib/radar'

/**
 * 🐛 Radar — reportar e acompanhar, na topbar de toda tela interna.
 *
 * A gaveta faz as duas coisas de propósito, e nessa ordem: relatar em cima,
 * TODOS os reports do Pulse embaixo. Sem a lista, a mesma tela quebrada vira
 * cinco chamados iguais, e quem relatou não tem como saber que já está em
 * andamento — que é o que faz a pessoa parar de relatar.
 *
 * Não é um formulário para o Pulse: é o formulário do Radar
 * (radar.alloyal.com.br), a central da casa. Aqui só se evita a troca de
 * contexto — quem achou o defeito descreve na hora, com o print colado, sem
 * abrir outro sistema e perder o que estava fazendo.
 */

const EMOJI_DO_TIPO: Record<string, string> = { bug: '🐛', melhoria: '⚡', feature: '✨' }

const ROTULO_DO_STATUS: Record<string, string> = {
  aberto: 'Em aberto',
  em_andamento: 'Em andamento',
  realizado: 'Realizado',
  recusado: 'Recusado',
}

const TOM_DO_STATUS: Record<string, Tom> = {
  aberto: 'amber',
  em_andamento: 'blue',
  realizado: 'green',
  recusado: 'slate',
}

/**
 * A cor de cada grau sai de `TOM_POR_FAIXA`, e não de um mapa novo.
 *
 * O Radar chama de "urgente" o grau que a fila do Pulse chama de "crítica". São
 * a mesma coisa, e pintá-las de vermelhos diferentes por virem de mapas
 * diferentes é como a cor deixa de ser sinal e vira decoração.
 */
const TOM_DA_CRITICIDADE: Record<string, Tom> = {
  baixa: TOM_POR_FAIXA['baixa'] ?? 'slate',
  media: TOM_POR_FAIXA['media'] ?? 'amber',
  alta: TOM_POR_FAIXA['alta'] ?? 'orange',
  urgente: TOM_POR_FAIXA['critica'] ?? 'red',
}

const MAX_ANEXO_BYTES = 10 * 1024 * 1024
const MAX_ANEXOS = 10

/**
 * Teto do CONJUNTO, que é diferente do teto por arquivo.
 *
 * Quem manda aqui não é o Radar (10 MB por arquivo, dez arquivos): é o corpo da
 * Server Action, limitado a 25 MB em `next.config.mjs`. Dez anexos de 10 MB
 * passariam nas duas checagens de arquivo e morreriam no envio — depois de a
 * pessoa ter escrito o relato inteiro. 20 MB deixa a folga do multipart.
 */
const MAX_TOTAL_BYTES = 20 * 1024 * 1024

function dia(iso: string): string {
  return new Date(iso).toLocaleDateString('pt-BR')
}

export function PainelDoRadar() {
  const [aberta, setAberta] = useState(false)
  const [mostrarForm, setMostrarForm] = useState(false)

  const [tipo, setTipo] = useState('bug')
  const [criticidade, setCriticidade] = useState('media')
  const [titulo, setTitulo] = useState('')
  const [descricao, setDescricao] = useState('')
  const [anexos, setAnexos] = useState<File[]>([])
  const [enviando, setEnviando] = useState(false)
  const [resultado, setResultado] = useState<{ ok: boolean; texto: string } | null>(null)

  const [itens, setItens] = useState<Demanda[]>([])
  const [eu, setEu] = useState('')
  const [carregando, setCarregando] = useState(false)
  const [filtroStatus, setFiltroStatus] = useState('todos')
  const [filtroAutoria, setFiltroAutoria] = useState('todos')

  const seletor = useRef<HTMLInputElement>(null)

  const adicionar = useCallback(
    (novos: File[]) => {
      const grandes = novos.filter((f) => f.size > MAX_ANEXO_BYTES).length
      let total = anexos.reduce((soma, f) => soma + f.size, 0)
      const cabem: File[] = []
      let sobrou = false

      for (const f of novos) {
        if (f.size === 0 || f.size > MAX_ANEXO_BYTES) continue
        if (anexos.length + cabem.length >= MAX_ANEXOS || total + f.size > MAX_TOTAL_BYTES) {
          sobrou = true
          break
        }
        total += f.size
        cabem.push(f)
      }

      // Uma mensagem por vez, e a mais específica primeiro: dizer "passou de 20 MB"
      // sobre um arquivo que foi recusado por ter 30 MB manda consertar a coisa errada.
      if (grandes > 0) {
        setResultado({ ok: false, texto: `${grandes} arquivo(s) acima de 10 MB ficaram de fora.` })
      } else if (sobrou) {
        setResultado({
          ok: false,
          texto: `Cabem ${MAX_ANEXOS} anexos e 20 MB no total — o resto ficou de fora.`,
        })
      }
      if (cabem.length > 0) setAnexos((antes) => [...antes, ...cabem])
    },
    [anexos],
  )

  /**
   * Colar o print direto no formulário (Ctrl+V).
   *
   * É o caminho mais curto que existe entre ver o defeito e relatá-lo: a pessoa
   * já deu o print, a imagem já está no clipboard. Obrigar a salvar em disco e
   * procurar o arquivo é onde metade dos relatos morre.
   */
  const aoColar = useCallback(
    (e: React.ClipboardEvent) => {
      const imagens = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'))
      if (imagens.length === 0) return
      adicionar(
        imagens.map((f, i) =>
          // O clipboard entrega tudo como "image.png"; três prints colados
          // viravam três anexos de mesmo nome, indistinguíveis na demanda.
          f.name && f.name !== 'image.png' ? f : new File([f], `print-${i + 1}.png`, { type: f.type }),
        ),
      )
    },
    [adicionar],
  )

  const carregar = useCallback(() => {
    setCarregando(true)
    reportsDoRadar()
      .then((r) => {
        setItens(r.itens)
        setEu(r.eu)
      })
      .finally(() => setCarregando(false))
  }, [])

  useEffect(() => {
    if (aberta) carregar()
  }, [aberta, carregar])

  const visiveis = itens.filter(
    (d) =>
      (filtroStatus === 'todos' || d.status === filtroStatus) &&
      (filtroAutoria === 'todos' || (filtroAutoria === 'meus' ? d.autor === eu : d.autor !== eu)),
  )

  async function enviar(e: React.FormEvent) {
    e.preventDefault()
    if (!titulo.trim() || !descricao.trim()) {
      setResultado({ ok: false, texto: 'Preencha título e descrição.' })
      return
    }
    setEnviando(true)
    setResultado(null)

    const dados = new FormData()
    dados.set('tipo', tipo)
    dados.set('criticidade', criticidade)
    dados.set('titulo', titulo)
    dados.set('descricao', descricao)
    for (const f of anexos) dados.append('anexos', f)

    const r = await reportar(dados)
    setEnviando(false)
    if (!r.ok) {
      setResultado({ ok: false, texto: r.erro ?? 'Não deu para registrar.' })
      return
    }
    setResultado({
      ok: true,
      texto: `Registrado no Radar — protocolo #${r.protocolo}.${r.avisoAnexos ? ` (${r.avisoAnexos})` : ''}`,
    })
    setTitulo('')
    setDescricao('')
    setAnexos([])
    setMostrarForm(false)
    carregar()
  }

  return (
    <>
      <BotaoDeTopo
        icone={Bug}
        titulo="Radar — reportar bug, melhoria ou feature"
        aoClicar={() => setAberta(true)}
      />

      <Gaveta
        titulo="Radar · Pulse"
        legenda="bugs, melhorias e features"
        icone={Bug}
        aberta={aberta}
        aoFechar={() => setAberta(false)}
      >
        <section className="border-b border-line px-5 py-4">
          {!mostrarForm ? (
            <>
              <Btn
                onClick={() => {
                  setMostrarForm(true)
                  setResultado(null)
                }}
                className="w-full"
              >
                <Plus className="h-4 w-4" /> Novo report
              </Btn>
              {resultado?.ok && (
                <div className="mt-3">
                  <Aviso tom="ok" papel="status">
                    {resultado.texto}
                  </Aviso>
                </div>
              )}
            </>
          ) : (
            <form onSubmit={enviar} onPaste={aoColar} className="grid gap-3">
              <div className="flex items-center">
                <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">
                  Novo report
                </h3>
                <Btn
                  variant="ghost"
                  onClick={() => setMostrarForm(false)}
                  className="ml-auto h-7 border-0 px-2 text-[12.5px] text-ink-3"
                >
                  Cancelar
                </Btn>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Select label="Tipo" value={tipo} onChange={(e) => setTipo(e.target.value)}>
                  <option value="bug">🐛 Bug</option>
                  <option value="melhoria">⚡ Melhoria</option>
                  <option value="feature">✨ Feature</option>
                </Select>
                <Select
                  label="Criticidade"
                  value={criticidade}
                  onChange={(e) => setCriticidade(e.target.value)}
                >
                  <option value="baixa">Baixa</option>
                  <option value="media">Média</option>
                  <option value="alta">Alta</option>
                  <option value="urgente">Urgente</option>
                </Select>
              </div>

              <Field
                label="Título"
                value={titulo}
                maxLength={200}
                placeholder="Resumo curto e objetivo"
                onChange={(e) => setTitulo(e.target.value)}
              />

              <TextArea
                label="Descrição"
                value={descricao}
                rows={4}
                maxLength={5000}
                placeholder="O que aconteceu, o que era esperado e como repetir. Cole o print aqui (Ctrl+V)."
                onChange={(e) => setDescricao(e.target.value)}
              />

              <div className="grid gap-1.5">
                <span className="text-[13px] font-medium text-ink-2">
                  Anexos{' '}
                  <span className="font-normal text-ink-3">
                    — até 10 MB cada e 20 MB no total, ou cole com Ctrl+V
                  </span>
                </span>
                {/* ds-excecao: seletor de arquivo escondido não tem aparência para padronizar, e o gatilho visível é um Btn */}
                <input
                  ref={seletor}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    adicionar(Array.from(e.target.files ?? []))
                    e.target.value = ''
                  }}
                />
                <div className="flex flex-wrap items-center gap-1.5">
                  <Btn
                    variant="ghost"
                    onClick={() => seletor.current?.click()}
                    className="h-8 px-2.5 text-[12.5px] font-medium text-ink-2"
                  >
                    <Paperclip className="h-3.5 w-3.5" /> Anexar arquivo
                  </Btn>
                  {anexos.map((f, i) => (
                    <span
                      key={`${f.name}-${i}`}
                      title={f.name}
                      className="inline-flex max-w-56 items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-[12px] text-ink-2"
                    >
                      {f.type.startsWith('image/') ? (
                        <ImagePlus className="h-3 w-3 shrink-0 text-purple-500" />
                      ) : (
                        <Paperclip className="h-3 w-3 shrink-0 text-ink-3" />
                      )}
                      <span className="truncate">{f.name}</span>
                      <Btn
                        variant="ghost"
                        title={`Tirar ${f.name}`}
                        onClick={() => setAnexos((antes) => antes.filter((_, j) => j !== i))}
                        className="h-4 w-4 border-0 px-0 text-ink-3"
                      >
                        <X className="h-3 w-3" />
                      </Btn>
                    </span>
                  ))}
                </div>
              </div>

              {resultado && (
                <Aviso tom={resultado.ok ? 'ok' : 'erro'} papel={resultado.ok ? 'status' : 'alert'}>
                  {resultado.texto}
                </Aviso>
              )}

              <div className="flex justify-end">
                <Btn type="submit" disabled={enviando}>
                  {enviando ? 'Enviando…' : 'Enviar report'}
                </Btn>
              </div>
            </form>
          )}
        </section>

        <section className="px-5 py-4">
          <div className="mb-3 flex items-center gap-2">
            <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-ink-3">
              Todos os reports {itens.length > 0 && `(${visiveis.length}/${itens.length})`}
            </h3>
            <Btn
              variant="ghost"
              onClick={carregar}
              title="Atualizar"
              className="ml-auto h-7 w-7 border-0 px-0 text-ink-3"
            >
              <RefreshCw className={carregando ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
            </Btn>
          </div>

          <div className="mb-3 grid grid-cols-2 gap-2">
            <Select
              value={filtroStatus}
              onChange={(e) => setFiltroStatus(e.target.value)}
              className="h-8 text-[12.5px]"
            >
              <option value="todos">Status: todos</option>
              <option value="aberto">Em aberto</option>
              <option value="em_andamento">Em andamento</option>
              <option value="realizado">Realizado</option>
              <option value="recusado">Recusado</option>
            </Select>
            <Select
              value={filtroAutoria}
              onChange={(e) => setFiltroAutoria(e.target.value)}
              className="h-8 text-[12.5px]"
            >
              <option value="todos">Autor: todos</option>
              <option value="meus">Abertos por mim</option>
              <option value="outros">Abertos por outros</option>
            </Select>
          </div>

          {carregando && itens.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-ink-3">Carregando…</p>
          ) : visiveis.length === 0 ? (
            <p className="py-6 text-center text-[13px] text-ink-3">
              {itens.length === 0
                ? 'Nenhum report do Pulse ainda.'
                : 'Nenhum report com esses filtros.'}
            </p>
          ) : (
            <ul className="flex flex-col gap-2.5">
              {visiveis.map((d) => (
                <li key={d.id} className="rounded-md border border-line bg-surface-2 p-3">
                  <div className="mb-1.5 flex items-start gap-2">
                    <span className="shrink-0" title={d.tipo}>
                      {EMOJI_DO_TIPO[d.tipo] ?? '•'}
                    </span>
                    <p className="text-[13.5px] font-medium leading-snug text-ink">{d.titulo}</p>
                    <span className="ml-auto shrink-0 text-[11px] tabular-nums text-ink-3">
                      #{d.protocolo}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={TOM_DO_STATUS[d.status] ?? 'slate'}>
                      {ROTULO_DO_STATUS[d.status] ?? d.status}
                    </Badge>
                    <Badge tone={TOM_DA_CRITICIDADE[d.criticidade] ?? 'slate'}>{d.criticidade}</Badge>
                    {d.previsaoSolucao && d.status !== 'realizado' && d.status !== 'recusado' && (
                      <Badge tone="indigo">
                        previsão{' '}
                        {new Date(d.previsaoSolucao).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}
                      </Badge>
                    )}
                    <span className="ml-auto text-[11px] text-ink-3">
                      {d.autor.split('@')[0]} · {dia(d.createdAt)}
                    </span>
                  </div>
                  {d.notaDeRelease && (
                    <p className="mt-2 rounded-md bg-green-50 px-2.5 py-1.5 text-[12px] leading-snug text-green">
                      ✨ {d.notaDeRelease}
                    </p>
                  )}
                  {d.detalheResolucao && (
                    <details className="group mt-2">
                      <summary className="cursor-pointer list-none text-[12px] font-medium text-purple-700">
                        <span className="group-open:hidden">▸ Ver detalhes</span>
                        <span className="hidden group-open:inline">▾ Ocultar detalhes</span>
                      </summary>
                      <p className="mt-1.5 whitespace-pre-wrap rounded-md bg-surface px-2.5 py-2 text-[12px] leading-relaxed text-ink-2">
                        {d.detalheResolucao}
                      </p>
                    </details>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </Gaveta>
    </>
  )
}
