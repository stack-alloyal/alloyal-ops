import {
  acuracia,
  calendario,
  JANELA_DIAS,
  listar,
  META_ERRO_O6,
  MINIMO_PARA_ACURACIA,
  previsao,
  type Renovacao,
} from '@pulse/success'
import { Aviso, Badge, Btn, Card, Field, Kpi, Select, Table, Vazio, cn } from '@pulse/ui'
import Link from 'next/link'

import { acaoCenario, acaoDesfecho } from './acoes'
import { Corpo, Topo } from '../casca'
import { pool } from '../../../lib/db'
import { exigir, temEscopo } from '../../../lib/guarda'

export const dynamic = 'force-dynamic'

/**
 * Renovação — nunca descobrir um vencimento pelo vencimento.
 *
 * A tela mostra a previsão como FAIXA e, do lado dela, o acerto das previsões
 * passadas. As duas juntas de propósito: previsão sem histórico de acerto é um
 * número que ninguém consegue contestar, e um time que marca tudo como otimista
 * produz exatamente isso.
 *
 * O que é AÇÃO é a coluna do cenário: enquanto a janela está aberta, a leitura do
 * CSM ainda pode mudar. Depois do desfecho ela congela, senão a acurácia é
 * reescrita para bater.
 */

const REAIS = (c: string) =>
  (Number(c) / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 0,
  })

const PCT = (v: number | null) =>
  v === null ? '—' : `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}%`

const CENARIO: Record<string, { rotulo: string; tom: 'green' | 'blue' | 'red' }> = {
  otimista: { rotulo: 'Otimista', tom: 'green' },
  base: { rotulo: 'Base', tom: 'blue' },
  pessimista: { rotulo: 'Pessimista', tom: 'red' },
}

const ESTADO: Record<string, { rotulo: string; tom: 'amber' | 'blue' | 'green' | 'red' }> = {
  aberta: { rotulo: 'Não avaliada', tom: 'amber' },
  em_negociacao: { rotulo: 'Em negociação', tom: 'blue' },
  renovada: { rotulo: 'Renovada', tom: 'green' },
  perdida: { rotulo: 'Perdida', tom: 'red' },
}

/**
 * O prazo que importa não é o vencimento: é o vencimento menos o aviso prévio.
 *
 * "Vence em 45 dias" parece folga até se ver que o aviso é de 60 — o cliente já
 * poderia ter avisado, e a janela de conversa está aberta agora.
 */
function prazo(r: Renovacao): { texto: string; cor: string } {
  const d = r.diasParaVigencia
  const aviso = r.avisoPrevioDias ?? 0
  if (d < 0) return { texto: `venceu há ${-d} d`, cor: 'text-red' }
  if (d <= aviso) {
    return { texto: `vence em ${d} d · aviso de ${aviso} d já aberto`, cor: 'text-red' }
  }
  return {
    texto: `vence em ${d} d · aviso abre em ${d - aviso} d`,
    cor: d <= 45 ? 'text-amber-700' : 'text-ink-3',
  }
}

function Linha({ r }: { r: Renovacao }) {
  const e = ESTADO[r.estado]!
  const p = prazo(r)
  const aberta = r.estado === 'aberta' || r.estado === 'em_negociacao'

  return (
    <li
      className={cn(
        'rounded-lg border border-line border-l-[3px] bg-surface p-[14px] shadow-sm',
        r.estado === 'aberta' && 'border-l-amber',
        r.estado === 'em_negociacao' && 'border-l-purple-500',
        r.estado === 'renovada' && 'border-l-green',
        r.estado === 'perdida' && 'border-l-red',
      )}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <Link
          href={`/contas/${r.accountId}`}
          className="text-[14px] font-bold tracking-[-0.01em] text-purple-700 hover:text-purple-500"
        >
          {r.conta}
        </Link>
        <span className="tabular-nums text-[12.5px] text-ink-3">
          {REAIS(r.mrrEmRiscoCentavos)}/mês em risco
        </span>
        <Badge tone={e.tom}>{e.rotulo}</Badge>
        {r.cenario && <Badge tone={CENARIO[r.cenario]!.tom}>{CENARIO[r.cenario]!.rotulo}</Badge>}
        <span className={cn('ml-auto text-[12.5px] font-semibold', p.cor)}>{p.texto}</span>
      </div>

      {r.nota && <p className="mt-1.5 text-[12.5px] text-ink-2">{r.nota}</p>}

      {aberta && (
        <div className="mt-3 grid gap-2 border-t border-line pt-3">
          <form action={acaoCenario} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="id" value={r.id} />
            <Select label="Leitura" name="cenario" defaultValue={r.cenario ?? 'base'} className="w-40">
              <option value="otimista">Otimista — renova e cresce</option>
              <option value="base">Base — renova como está</option>
              <option value="pessimista">Pessimista — vai perder</option>
            </Select>
            <div className="min-w-[14em] flex-1">
              <Field label="Nota" name="nota" type="text" placeholder="O que sustenta a leitura?" maxLength={500} />
            </div>
            <Btn type="submit" variant="ghost">
              Registrar leitura
            </Btn>
          </form>

          <form action={acaoDesfecho} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="id" value={r.id} />
            {/* Fechar é o que alimenta a acurácia. Renovação eternamente aberta
                deixa o O6 sem contra o que medir, e meta inverificável é o mesmo
                que meta nenhuma. */}
            <Btn type="submit" name="desfecho" value="renovada">
              Renovada
            </Btn>
            <Btn type="submit" name="desfecho" value="perdida" variant="danger">
              Perdida
            </Btn>
            <span className="text-[12px] text-ink-3">
              O desfecho entra na acurácia da previsão, e não sai mais.
            </span>
          </form>
        </div>
      )}
    </li>
  )
}

export default async function Renovacoes({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string }>
}) {
  const id = await exigir((p) => temEscopo(p.contas), 'renovações')
  const q = await searchParams

  const veReceita = id.permissoes.receita !== 'nenhum' || id.permissoes.configurar
  const [renovacoes, prev, acc, cal] = await Promise.all([
    listar(pool(), id),
    veReceita ? previsao(pool()) : null,
    veReceita ? acuracia(pool()) : null,
    veReceita ? calendario(pool(), 12) : null,
  ])

  const abertas = renovacoes.filter((r) => r.estado === 'aberta' || r.estado === 'em_negociacao')
  const fechadas = renovacoes.filter((r) => r.estado === 'renovada' || r.estado === 'perdida')
  const naoAvaliadas = abertas.filter((r) => r.cenario === null).length

  return (
    <>
      <Topo href="/renovacoes" />
      <Corpo className="grid gap-5">
        {q.erro && <Aviso tom="erro" papel="alert">{q.erro}</Aviso>}
        {q.ok && <Aviso tom="ok" papel="status">{q.ok}</Aviso>}

        {prev && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Kpi
                rotulo={`Em risco · ${JANELA_DIAS} dias`}
                valor={REAIS(prev.mrrTotalCentavos)}
                nota={`${prev.quantas} renovação(ões) na janela`}
              />
              {/* A faixa, e não um número: previsão única é falsa precisão. */}
              <Kpi
                rotulo="Previsão base"
                valor={REAIS(prev.baseCentavos)}
                nota={`faixa: ${REAIS(prev.pessimistaCentavos)} a ${REAIS(prev.otimistaCentavos)}`}
              />
              <Kpi
                rotulo="Sem leitura"
                valor={REAIS(prev.mrrSemAvaliacaoCentavos)}
                nota={`${prev.semAvaliacao} conta(s) contadas no base sem ninguém ter avaliado`}
                {...(prev.semAvaliacao > 0 ? { tom: 'amber' as const } : {})}
              />
              {acc && (
                <Kpi
                  rotulo="Erro da previsão (O6)"
                  valor={PCT(acc.erro)}
                  nota={
                    acc.erro === null
                      ? 'nada renovado no período — sem base para medir'
                      : `meta ≤ ${PCT(META_ERRO_O6)} · ${acc.fechadas} fechada(s)`
                  }
                  {...(acc.erro !== null
                    ? { tom: acc.erro <= META_ERRO_O6 ? ('green' as const) : ('red' as const) }
                    : {})}
                />
              )}
            </div>
            <p className="max-w-[80ch] text-[13px] leading-relaxed text-ink-2">
              A previsão é uma <strong className="font-semibold">faixa</strong>: no otimista tudo
              renova, no base renova o que ninguém marcou como perda provável, no pessimista só o
              que alguém marcou como certo. Número único seria falsa precisão. O erro do O6 ao lado
              existe porque previsão sem histórico de acerto é um número que ninguém consegue
              contestar — e um time que marca tudo como otimista produz exatamente isso.
            </p>
          </>
        )}

        {naoAvaliadas > 0 && (
          <Aviso tom="alerta">
            {naoAvaliadas} renovação(ões) na janela sem leitura registrada. Elas entram na previsão
            base como se fossem renovar, e ninguém olhou ainda.
          </Aviso>
        )}

        <Card title={`Na janela (${abertas.length})`}>
          {abertas.length === 0 ? (
            <Vazio
              titulo="Nenhuma renovação na janela."
              porque={`As janelas abrem automaticamente ${JANELA_DIAS} dias antes da vigência, pelo ciclo C14. Lista vazia significa que nenhum contrato vence nos próximos ${JANELA_DIAS} dias — não é erro de carregamento.`}
              acao={{ texto: 'Ver o pipeline de dados', href: '/dados' }}
              className="border-0 p-0"
            />
          ) : (
            <ul className="grid gap-3">
              {abertas.map((r) => (
                <Linha key={r.id} r={r} />
              ))}
            </ul>
          )}
        </Card>

        {cal && cal.length > 0 && (
          <Card title="Calendário de vencimentos">
            <Table
              cols={['Mês', 'Renovações', 'MRR a renovar', 'Já fechadas']}
              rows={cal.map((m) => [
                <span className="tabular-nums font-semibold">{m.mes}</span>,
                <span className="tabular-nums">{m.quantas}</span>,
                <span className="tabular-nums">{REAIS(m.mrrCentavos)}</span>,
                <span className="tabular-nums text-ink-3">
                  {m.fechadas} de {m.quantas}
                </span>,
              ])}
            />
          </Card>
        )}

        {acc && acc.porCsm.length > 0 && (
          <Card title="Acerto da leitura, por CSM">
            <Table
              cols={['CSM', 'Fechadas', 'Acertos', 'Taxa']}
              rows={acc.porCsm.map((c) => {
                // Fração sobre poucos casos é ruído: uma em três vira "33%" e
                // reprova quem fez duas chamadas certas.
                const taxa = c.fechadas >= MINIMO_PARA_ACURACIA ? c.acertos / c.fechadas : null
                return [
                  c.csm,
                  <span className="tabular-nums">{c.fechadas}</span>,
                  <span className="tabular-nums">{c.acertos}</span>,
                  taxa === null ? (
                    <span className="text-[12.5px] text-ink-3">
                      mínimo {MINIMO_PARA_ACURACIA}
                    </span>
                  ) : (
                    <span
                      className={cn('tabular-nums', taxa >= 0.7 ? 'text-green' : 'text-amber-700')}
                    >
                      {PCT(taxa)}
                    </span>
                  ),
                ]
              })}
            />
            <p className="mt-3 max-w-[80ch] text-[12.5px] text-ink-3">
              Renovação fechada sem leitura registrada conta como não acerto. É o incentivo que
              importa: quem não avalia não pode aparecer com 100%.
            </p>
          </Card>
        )}

        {fechadas.length > 0 && (
          <details>
            <summary className="cursor-pointer select-none text-[13px] font-semibold text-ink-2 hover:text-ink">
              {fechadas.length} já fechadas
            </summary>
            <ul className="mt-3 grid gap-3 opacity-75">
              {fechadas.map((r) => (
                <Linha key={r.id} r={r} />
              ))}
            </ul>
          </details>
        )}
      </Corpo>
    </>
  )
}
