import { listarRelatorios, type ConteudoRelatorio } from '@ops/success'
import { Aviso, Badge, Btn, Card, Field, Kpi, Table, cn } from '@ops/ui'
import { FileBarChart, Lock } from 'lucide-react'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { acaoEnviar, acaoRevisar } from '../acoes'
import { Corpo, Topo } from '../../casca'
import { pool } from '../../../lib/db'
import { exigir, temEscopo } from '../../../lib/guarda'

export const dynamic = 'force-dynamic'

/**
 * A página do relatório: o que o cliente vai ver, e a revisão antes de enviar.
 *
 * A prévia é o MESMO componente que o PDF renderiza — paridade por construção, não
 * por conferência. Duas renderizações diferentes do mesmo relatório é como o PDF sai
 * com um número que a tela não mostrava.
 *
 * A frase é editável até o envio, e as duas versões ficam gravadas: comparar o que a
 * máquina escreveu com o que a pessoa corrigiu é o único jeito de descobrir que a
 * geração erra sempre no mesmo ponto.
 */

const PCT = (v: number | null) =>
  v === null ? '—' : `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}%`

const NUM = (v: number | null) => (v === null ? '—' : v.toLocaleString('pt-BR'))

const POSICAO: Record<string, string> = {
  abaixo_p25: 'abaixo do primeiro quartil',
  entre_p25_p50: 'abaixo da mediana',
  entre_p50_p75: 'acima da mediana',
  acima_p75: 'acima do terceiro quartil',
}

const ROTULO_METRICA: Record<string, string> = {
  adesao_30d: 'Adesão em 30 dias',
  cobertura_cadastral: 'Base cadastrada',
}

/** A variação com sinal e sem cor de julgamento: subir cobertura é bom, e é só isso. */
function Variacao({ v }: { v: number | null }) {
  if (v === null) {
    // Sem base de comparação. Dizer "0%" afirmaria estabilidade onde não há como
    // saber, e o cliente leria "não mudou nada".
    return <span className="text-[12px] text-ink-4">sem mês anterior</span>
  }
  const pct = Math.round(v * 100)
  return (
    <span
      className={cn('text-[12px] font-semibold', v > 0.02 ? 'text-green' : v < -0.02 ? 'text-red' : 'text-ink-3')}
    >
      {v > 0 ? '+' : ''}
      {pct}% vs. mês anterior
    </span>
  )
}

export default async function Relatorio({ params }: { params: Promise<{ id: string }> }) {
  const identidade = await exigir((p) => temEscopo(p.contas), 'relatório do cliente')
  const { id } = await params

  // Sem consulta por id no módulo: a lista já aplica o recorte de carteira, e
  // acrescentar uma leitura por id que ignore o recorte seria abrir um caminho
  // paralelo — que é como um CSM lê o relatório de outra carteira pela URL.
  const todos = await listarRelatorios(pool(), identidade)
  const r = todos.find((x) => x.id === id)
  if (!r) notFound()

  const c = r.conteudo as ConteudoRelatorio | null
  const enviado = r.estado === 'enviado'
  const podeRevisar = r.estado === 'rascunho' || r.estado === 'revisado'

  return (
    <>
      <Topo
        href="/relatorios"
        icone={FileBarChart}
        titulo={r.conta}
        proposito={`relatório de ${r.competencia.slice(0, 7)}`}
        acoes={
          <span className="flex items-center gap-2">
            {enviado && (
              <Badge tone="green">
                enviado a {r.destinatario} em{' '}
                {new Date(String(r.enviadoEm)).toLocaleDateString('pt-BR')}
              </Badge>
            )}
            {r.estado === 'revisado' && <Badge tone="blue">revisado — pronto para enviar</Badge>}
            {r.estado === 'rascunho' && <Badge tone="amber">rascunho</Badge>}
            <Link
              href={`/contas/${r.accountId}`}
              className="text-[13px] font-semibold text-purple-700 hover:text-purple-500"
            >
              Cliente 360 →
            </Link>
          </span>
        }
      />
      <Corpo className="grid gap-5">
        {enviado && (
          <Aviso tom="ok">
            <Lock className="mr-1 inline h-[14px] w-[14px]" />
            Este relatório está congelado. O cliente tem uma cópia dos números abaixo, e por isso
            eles não mudam mesmo que a métrica seja recalculada. Para corrigir algo, componha um
            relatório novo que diga o que mudou.
          </Aviso>
        )}

        {c === null ? (
          <Aviso tom="alerta">
            Este relatório não tem conteúdo montado. Volte à lista e componha de novo.
          </Aviso>
        ) : (
          <>
            {c.dadoParcial && (
              <Aviso tom="alerta">
                O snapshot de {c.competencia.slice(0, 7)} saiu parcial: uma das fontes não respondeu
                no fechamento. A frase abaixo já diz isso ao cliente — não remova.
              </Aviso>
            )}

            {/* ── Bloco 1 ── */}
            <div>
              <h2 className="mb-2 text-[15px] font-bold tracking-[-0.01em] text-ink">
                O que aconteceu
              </h2>
              <div className="grid gap-3 sm:grid-cols-3">
                {c.numeros.map((n) => (
                  <Kpi
                    key={n.metrica}
                    rotulo={n.rotulo}
                    valor={n.unidade === 'percentual' ? PCT(n.valor) : NUM(n.valor)}
                    nota={<Variacao v={n.variacao} />}
                  />
                ))}
              </div>
            </div>

            {/* ── Bloco 2 ── */}
            {c.evolucao.length > 1 && (
              <Card title={`Evolução · ${c.evolucao.length} meses`}>
                {/* Tabela e não gráfico: o relatório vira PDF, e um gráfico exigiria
                    uma segunda renderização — que é como o PDF passa a mostrar um
                    número que a tela não mostrava. */}
                <Table
                  cols={['Mês', 'Adesão', 'Base cadastrada']}
                  rows={c.evolucao.map((p) => [
                    <span className="tabular-nums">{p.competencia}</span>,
                    <span className="tabular-nums">{PCT(p.adesao30d)}</span>,
                    <span className="tabular-nums">{PCT(p.coberturaCadastral)}</span>,
                  ])}
                />
              </Card>
            )}

            {/* ── Bloco 3 ── */}
            <Card title="Comparativo com empresas semelhantes">
              {c.comparativo.length === 0 ? (
                <p className="text-[13px] text-ink-3">
                  Sem comparativo nesta competência: o benchmark do porte e setor desta conta ainda
                  não foi calculado.
                </p>
              ) : (
                <ul className="grid gap-2">
                  {c.comparativo.map((x) => (
                    <li key={x.metrica} className="rounded-md border border-line bg-surface-2 p-3">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-3">
                        {ROTULO_METRICA[x.metrica] ?? x.metrica}
                      </span>
                      {x.suprimido ? (
                        /* Suprimido é EXPLICADO, não omitido: omitir faria o cliente
                           concluir que a Alloyal não sabe, em vez de entender que o
                           grupo é pequeno demais para comparação anônima. */
                        <p className="mt-1 text-[13px] text-ink-2">
                          Sem comparativo neste mês — o grupo de empresas de porte e setor
                          semelhantes é pequeno demais para uma comparação anônima.
                        </p>
                      ) : (
                        <div className="mt-1 flex flex-wrap items-baseline gap-3 text-[13.5px]">
                          <strong className="tabular-nums text-ink">
                            {PCT(x.valor)}
                          </strong>
                          <span className="text-ink-2">
                            {x.posicao ? POSICAO[x.posicao] : '—'} de{' '}
                            <strong className="font-semibold">{x.nEmpresas} empresas</strong>
                          </span>
                          <span className="tabular-nums text-[12.5px] text-ink-3">
                            p25 {PCT(x.p25)} · mediana {PCT(x.p50)} · p75 {PCT(x.p75)}
                          </span>
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            {/* ── Bloco 4 ── */}
            {c.acoes.length > 0 && (
              <Card title="O que depende de você">
                <ul className="grid gap-3">
                  {c.acoes.map((a) => (
                    <li
                      key={a.titulo}
                      className="rounded-md border border-line border-l-[3px] border-l-purple-500 bg-surface-2 p-3"
                    >
                      <strong className="text-[13.5px] font-bold text-ink">{a.titulo}</strong>
                      <span className="ml-2 tabular-nums text-[12.5px] font-semibold text-purple-700">
                        {a.numero}
                      </span>
                      <p className="mt-1 text-[13px] text-ink-2">{a.porque}</p>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </>
        )}

        {/* ── A frase, e a revisão ── */}
        <Card title="A frase que o cliente lê primeiro">
          {podeRevisar ? (
            <form action={acaoRevisar} className="grid gap-3">
              <input type="hidden" name="id" value={r.id} />
              <label className="block text-[13px]">
                <span className="mb-1 block font-medium text-ink-2">
                  Revise antes de enviar — você conhece o contexto que o número não tem
                </span>
                <textarea
                  name="frase"
                  rows={5}
                  minLength={40}
                  required
                  defaultValue={r.fraseFinal ?? r.fraseGerada ?? ''}
                  className="w-full rounded-sm border border-line-strong bg-surface px-3 py-2 text-[13.5px] leading-relaxed text-ink outline-none transition-colors focus:border-purple-500 focus:ring-2 focus:ring-purple-100"
                />
              </label>
              <div className="flex flex-wrap items-center gap-3">
                <Btn type="submit">
                  {r.estado === 'revisado' ? 'Salvar revisão' : 'Revisar e congelar'}
                </Btn>
                <span className="text-[12.5px] text-ink-3">
                  Revisar congela os números: a partir daí eles não mudam mesmo que a métrica seja
                  recalculada.
                </span>
              </div>
            </form>
          ) : (
            <p className="whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink">
              {r.fraseFinal}
            </p>
          )}

          {/* As duas frases ficam. A divergência entre elas mostra onde a geração
              erra sempre — e é a única forma de melhorá-la. */}
          {r.fraseGerada && r.fraseFinal && r.fraseGerada !== r.fraseFinal && (
            <details className="mt-3 text-[12.5px]">
              <summary className="cursor-pointer select-none text-ink-3 hover:text-ink-2">
                ver a frase que a máquina escreveu
              </summary>
              <p className="mt-2 rounded-md border border-dashed border-line bg-surface-2 p-3 leading-relaxed text-ink-3">
                {r.fraseGerada}
              </p>
            </details>
          )}
        </Card>

        {r.estado === 'revisado' && (
          <Card title="Enviar">
            <form action={acaoEnviar} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="id" value={r.id} />
              <div className="min-w-[18em]">
                <Field
                  label="E-mail do gestor"
                  name="destinatario"
                  type="email"
                  required
                  placeholder="rh@cliente.com.br"
                />
              </div>
              <Btn type="submit" variant="danger">
                Enviar e congelar definitivamente
              </Btn>
            </form>
            <p className="mt-3 max-w-[80ch] text-[12.5px] text-ink-3">
              O envio do e-mail em si depende de integração que ainda não existe. O que este passo
              grava é a prova de <em>que</em> foi enviado, <em>para quem</em> e <em>com que
              números</em> — e é essa prova que sustenta a conversa três meses depois.
            </p>
          </Card>
        )}
      </Corpo>
    </>
  )
}
