import { datasCriticas, HORIZONTE_MESES, resumirPorMes, type TipoData } from '@ops/contratos'
import { Aviso, Badge, Btn, Card, Field, Table, Vazio, cn } from '@ops/ui'
import { AlertTriangle, CalendarDays } from 'lucide-react'
import Link from 'next/link'

import { acaoObrigacao } from './acoes'
import { Corpo, Topo } from '../../casca'
import { pool } from '../../../lib/db'
import { exigir, temEscopo } from '../../../lib/guarda'

export const dynamic = 'force-dynamic'

/**
 * T22 — Calendário contratual. Nenhuma data crítica descoberta pela data.
 *
 * A lista é única e ordenada por data ENTRE tipos: um vencimento de amanhã tem que
 * aparecer antes de uma obrigação de daqui a três meses, e cinco listas separadas
 * por tipo tornariam isso impossível de ver.
 *
 * O que a tela destaca é o IRREVERSÍVEL. Vencimento com renovação automática é
 * aviso; janela de aviso e reajuste são perda que não se recupera depois da data, e
 * é neles que a atenção tem que cair primeiro.
 */

const REAIS = (c: string | null) =>
  c === null
    ? '—'
    : (Number(c) / 100).toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL',
        maximumFractionDigits: 0,
      })

const TIPO: Record<TipoData, { rotulo: string; tom: 'red' | 'amber' | 'blue' | 'orange' | 'slate' }> = {
  vencimento: { rotulo: 'Vencimento', tom: 'orange' },
  janela_de_aviso: { rotulo: 'Janela de aviso', tom: 'red' },
  reajuste: { rotulo: 'Reajuste', tom: 'blue' },
  obrigacao: { rotulo: 'Obrigação', tom: 'amber' },
  aditivo_pendente: { rotulo: 'Aditivo pendente', tom: 'slate' },
}

function quando(dias: number): { texto: string; cor: string } {
  if (dias < 0) return { texto: `há ${-dias} d`, cor: 'text-red' }
  if (dias === 0) return { texto: 'hoje', cor: 'text-red' }
  if (dias <= 15) return { texto: `em ${dias} d`, cor: 'text-orange-700' }
  return { texto: `em ${dias} d`, cor: 'text-ink-3' }
}

export default async function Calendario({
  searchParams,
}: {
  searchParams: Promise<{ ok?: string; erro?: string }>
}) {
  const id = await exigir((p) => temEscopo(p.contas), 'calendário contratual')
  const q = await searchParams
  const datas = await datasCriticas(pool(), id)
  const meses = resumirPorMes(datas)

  // As obrigações precisam do id para o formulário de fechamento; as outras datas
  // não têm ação direta nesta tela.
  const obrigacoes = await pool().query<{ id: string; account_id: string; prazo: string }>(
    `SELECT o.id, o.account_id, to_char(o.prazo,'YYYY-MM-DD') AS prazo
       FROM contracts.obligation o
       JOIN core.account a ON a.id = o.account_id
      WHERE o.estado = 'ativa' AND o.prazo IS NOT NULL
        AND ($1::boolean OR a.csm_email = $2)`,
    [id.permissoes.contas === 'base', id.email],
  )
  const idDaObrigacao = new Map(
    obrigacoes.rows.map((o) => [`${o.account_id}:${o.prazo}`, o.id]),
  )

  const vencidas = datas.filter((d) => d.dias < 0)
  const irreversiveisProximas = datas.filter((d) => d.irreversivel && d.dias >= 0 && d.dias <= 30)

  return (
    <>
      <Topo
        href="/contratos"
        icone={CalendarDays}
        titulo="Calendário contratual"
        proposito={`Próximos ${HORIZONTE_MESES} meses`}
        acoes={<span className="text-[13px] text-ink-2">{datas.length} data(s) crítica(s)</span>}
      />
      <Corpo className="grid gap-5">
        {q.erro && <Aviso tom="erro" papel="alert">{q.erro}</Aviso>}
        {q.ok && <Aviso tom="ok" papel="status">{q.ok}</Aviso>}

        {vencidas.length > 0 && (
          <Aviso tom="erro">
            <AlertTriangle className="mr-1 inline h-[14px] w-[14px]" />
            {vencidas.length} data(s) já passaram sem registro de ação. Data crítica descoberta
            pela data é exatamente o que esta tela existe para evitar.
          </Aviso>
        )}

        {irreversiveisProximas.length > 0 && (
          <Aviso tom="alerta">
            {irreversiveisProximas.length} data(s) irreversível(is) nos próximos 30 dias — janela de
            aviso, reajuste ou vencimento com renovação expressa. Passar delas é perda que não se
            recupera naquele ciclo.
          </Aviso>
        )}

        {meses.length > 0 && (
          <Card title="Por mês, com o MRR afetado">
            <Table
              cols={['Mês', 'Datas', 'MRR afetado', 'Vencidas', 'Irreversíveis']}
              rows={meses.map((m) => [
                <span className="tabular-nums font-semibold">{m.mes}</span>,
                <span className="tabular-nums">{m.quantas}</span>,
                <span className="tabular-nums">{REAIS(m.mrrAfetadoCentavos)}</span>,
                <span className={m.vencidas > 0 ? 'tabular-nums text-red' : 'tabular-nums text-ink-3'}>
                  {m.vencidas || ''}
                </span>,
                <span className={m.irreversiveis > 0 ? 'tabular-nums text-orange-700' : 'tabular-nums text-ink-3'}>
                  {m.irreversiveis || ''}
                </span>,
              ])}
            />
            <p className="mt-3 max-w-[80ch] text-[12.5px] text-ink-3">
              O MRR afetado conta cada conta uma vez por mês: vencimento, janela de aviso e reajuste
              da mesma conta no mesmo mês afetam o faturamento uma vez, não três.
            </p>
          </Card>
        )}

        <Card title="Datas críticas, em ordem">
          {datas.length === 0 ? (
            <Vazio
              titulo="Nenhuma data crítica nos próximos meses."
              porque={`O calendário olha ${HORIZONTE_MESES} meses à frente e cobre vencimento, janela de aviso, reajuste, obrigação a vencer e aditivo pendente de assinatura. Vazio significa que nenhuma dessas datas cai na janela — e não que o calendário não carregou.`}
              acao={{ texto: 'Ver a consulta de contratos', href: '/contratos' }}
              className="border-0 p-0"
            />
          ) : (
            <ul className="grid gap-2">
              {datas.map((d, i) => {
                const t = TIPO[d.tipo]
                const w = quando(d.dias)
                const obrigacaoId =
                  d.tipo === 'obrigacao' ? idDaObrigacao.get(`${d.accountId}:${d.data}`) : undefined
                return (
                  <li
                    key={`${d.tipo}-${d.accountId}-${d.data}-${i}`}
                    className={cn(
                      'rounded-md border border-line border-l-[3px] bg-surface p-3',
                      d.dias < 0 && 'border-l-red bg-red-50/40',
                      d.dias >= 0 && d.irreversivel && 'border-l-orange-500',
                      d.dias >= 0 && !d.irreversivel && 'border-l-line-strong',
                    )}
                  >
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="tabular-nums text-[12.5px] font-semibold text-ink">
                        {d.data}
                      </span>
                      <span className={cn('text-[12.5px] font-semibold', w.cor)}>{w.texto}</span>
                      <Badge tone={t.tom}>{t.rotulo}</Badge>
                      <Link
                        href={`/contratos/${d.accountId}`}
                        className="text-[13.5px] font-semibold text-purple-700 hover:text-purple-500"
                      >
                        {d.conta}
                      </Link>
                      <span className="tabular-nums text-[12.5px] text-ink-3">
                        {REAIS(d.mrrCentavos)}/mês
                      </span>
                      {d.irreversivel && (
                        <span className="text-[11.5px] font-semibold uppercase tracking-wide text-orange-700">
                          irreversível
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[13px] text-ink-2">{d.descricao}</p>
                    {d.donoEmail && (
                      <p className="mt-0.5 text-[11.5px] text-ink-3">dono: {d.donoEmail}</p>
                    )}

                    {obrigacaoId && (
                      <form action={acaoObrigacao} className="mt-2 flex flex-wrap items-end gap-2">
                        <input type="hidden" name="id" value={obrigacaoId} />
                        <Btn type="submit" name="acao" value="cumprir" variant="ghost">
                          Cumprida
                        </Btn>
                        <div className="min-w-[14em] flex-1">
                          {/* Dispensar exige motivo: sem ele, dispensar viraria o
                              caminho fácil e a lista de vencidas esvaziaria sozinha. */}
                          <Field
                            name="motivo"
                            type="text"
                            placeholder="Motivo, se for dispensar"
                            maxLength={300}
                          />
                        </div>
                        <Btn type="submit" name="acao" value="dispensar" variant="ghost">
                          Dispensar
                        </Btn>
                      </form>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        <p className="max-w-[80ch] text-[13px] leading-relaxed text-ink-2">
          A <strong className="font-semibold">janela de aviso</strong> é a data que a operação mais
          esquece e a mais caroa: com renovação automática, deixá-la passar prende por mais um
          ciclo; com renovação expressa, perde o contrato por silêncio. A mesma data, duas
          consequências opostas — e é por isso que a renovação é cláusula tipada. Prazo calculado
          sobre cláusula <em>proposta</em> não entra: valor não conferido mandaria alguém agir com o
          prazo errado.
        </p>
      </Corpo>
    </>
  )
}
