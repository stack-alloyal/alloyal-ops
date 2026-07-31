import { especificacao, historicoDoTipo, valeHoje, type TipoClausula } from '@pulse/contratos'
import { Aviso, Badge, Card, Kpi, cn } from '@pulse/ui'
import { FileText, Lock } from 'lucide-react'
import Link from 'next/link'
import { notFound } from 'next/navigation'

import { Corpo, Topo } from '../../casca'
import { pool } from '../../../../lib/db'
import { exigir, temEscopo } from '../../../../lib/guarda'
import { uuidOu404 } from '../../../../lib/parametro'

export const dynamic = 'force-dynamic'

/**
 * T21 — Ficha do contrato.
 *
 * Responde "o que vale HOJE" — não "o que o contrato dizia". Com aditivo as duas
 * respostas divergem, e é a primeira que a operação precisa.
 *
 * A regra que a tela impõe: nenhuma cláusula é editável. Só substituída por outra,
 * com documento de origem. Corrigir erro de digitação também é uma correção
 * registrada, não uma sobrescrita silenciosa — senão a resposta para "por que
 * mudou?" desaparece.
 */

const REAIS = (c: string | null) =>
  c === null
    ? '—'
    : (Number(c) / 100).toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL',
        maximumFractionDigits: 0,
      })

function valorLegivel(v: Record<string, unknown> | null): string {
  if (!v) return '—'
  if (typeof v['valor'] === 'string') return v['valor'].replace(/_/g, ' ')
  const partes = Object.entries(v).map(([k, x]) => `${k.replace(/_/g, ' ')}: ${String(x)}`)
  return partes.length > 0 ? partes.join(' · ') : '—'
}

interface Cabecalho {
  razao_social: string
  numero_contrato: string | null
  mrr_centavos: string | null
  vigencia_fim: string | null
  encerrado_em: string | null
  status_vigencia: string | null
  renovacao: string | null
  tipo_receita: string | null
}

export default async function FichaContrato({ params }: { params: Promise<{ id: string }> }) {
  const id = await exigir((p) => temEscopo(p.contas), 'ficha de contrato')
  const { id: accountIdBruto } = await params
  // Formato antes da consulta: id torto virava 500, e 500 previsível esconde o real.
  const accountId = uuidOu404(accountIdBruto)

  const { rows } = await pool().query<Cabecalho>(
    `SELECT a.razao_social, ct.numero_contrato, ct.mrr_centavos::text AS mrr_centavos,
            to_char(ct.vigencia_fim,'YYYY-MM-DD')  AS vigencia_fim,
            to_char(ct.encerrado_em,'YYYY-MM-DD')  AS encerrado_em,
            ct.status_vigencia, ct.renovacao, ct.tipo_receita
       FROM core.account a
       LEFT JOIN LATERAL (
         SELECT * FROM core.contract
          WHERE account_id = a.id ORDER BY status_vigencia = 'vigente' DESC, inicio DESC LIMIT 1
       ) ct ON true
      WHERE a.id = $1`,
    [accountId],
  )
  const c = rows[0]
  if (!c) notFound()

  const clausulas = await valeHoje(pool(), id, accountId)
  // O histórico só de quem foi substituído: mostrar a linha do tempo de tudo
  // afogaria o que mudou no que nunca mudou.
  const tiposComHistorico = [...new Set(clausulas.map((x) => x.tipo))]
  const historicos = await Promise.all(
    tiposComHistorico.map(async (t) => ({
      tipo: t,
      versoes: await historicoDoTipo(pool(), id, accountId, t as TipoClausula),
    })),
  )
  const mudaram = historicos.filter((h) => h.versoes.length > 1)

  const propostas = clausulas.filter((x) => x.estado === 'proposta').length
  const restritas = clausulas.filter((x) => x.restrito).length

  return (
    <>
      <Topo
        href="/contratos"
        icone={FileText}
        titulo={c.razao_social}
        proposito={c.numero_contrato ? `contrato ${c.numero_contrato}` : 'sem número de contrato'}
        acoes={
          <span className="flex items-center gap-2">
            <Link
              href={`/contas/${accountId}`}
              className="text-[13px] font-semibold text-purple-700 hover:text-purple-500"
            >
              Cliente 360 →
            </Link>
            {c.status_vigencia && (
              <Badge tone={c.status_vigencia === 'vigente' ? 'green' : 'slate'}>
                {c.status_vigencia}
              </Badge>
            )}
          </span>
        }
      />
      <Corpo className="grid gap-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Kpi rotulo="MRR" valor={REAIS(c.mrr_centavos)} nota={c.tipo_receita ?? undefined} />
          <Kpi
            rotulo="Vigência"
            valor={<span className="text-[22px]">{c.vigencia_fim ?? '—'}</span>}
            /* O fim CONTRATADO e o encerramento de fato são fatos diferentes, e a
               diferença entre eles é o prazo restante — o que caracteriza multa. */
            nota={c.encerrado_em ? `encerrado de fato em ${c.encerrado_em}` : 'fim contratado'}
            {...(c.encerrado_em ? { tom: 'red' as const } : {})}
          />
          <Kpi rotulo="Renovação" valor={<span className="text-[22px]">{c.renovacao ?? '—'}</span>} />
          <Kpi
            rotulo="Cláusulas"
            valor={clausulas.length}
            nota={[
              propostas > 0 ? `${propostas} proposta(s)` : null,
              restritas > 0 ? `${restritas} restrita(s) para você` : null,
            ]
              .filter(Boolean)
              .join(' · ')}
            {...(propostas > 0 ? { tom: 'amber' as const } : {})}
          />
        </div>

        {propostas > 0 && (
          <Aviso tom="alerta">
            {propostas} cláusula(s) desta conta estão <strong className="font-semibold">propostas</strong>:
            foram extraídas e ainda não conferidas. Elas não valem para decisão — não confirmam aviso
            prévio, não validam cancelamento e não alimentam alerta.
          </Aviso>
        )}

        <Card title="O que vale hoje">
          {clausulas.length === 0 ? (
            <p className="text-[13px] text-ink-3">
              Nenhuma cláusula registrada para esta conta. A captação começa pela fila de
              confirmação, ordenada por MRR — este contrato aparece lá conforme o valor.
            </p>
          ) : (
            <ul className="grid gap-3">
              {clausulas.map((x) => {
                const spec = especificacao(x.tipo)
                const hist = mudaram.find((h) => h.tipo === x.tipo)
                return (
                  <li
                    key={x.id}
                    className={cn(
                      'rounded-md border border-line border-l-[3px] bg-surface-2 p-3',
                      x.restrito && 'border-l-ink-4',
                      !x.restrito && x.estado === 'proposta' && 'border-l-amber',
                      !x.restrito && x.estado === 'confirmada' && 'border-l-green',
                    )}
                  >
                    <div className="flex flex-wrap items-baseline gap-2">
                      <strong className="text-[13.5px] font-bold text-ink">{x.rotulo}</strong>
                      {x.restrito ? (
                        <span className="inline-flex items-center gap-1 text-[13px] text-ink-3">
                          <Lock className="h-[13px] w-[13px]" />
                          {x.avisoRestricao}
                        </span>
                      ) : (
                        <span className="text-[13.5px] text-ink">
                          {valorLegivel(x.valorEstruturado)}
                        </span>
                      )}
                      {x.estado === 'proposta' && !x.restrito && (
                        <Badge tone="amber">proposta — não vale para decisão</Badge>
                      )}
                    </div>

                    {spec && <p className="mt-1 text-[12px] text-ink-3">{spec.pergunta}</p>}

                    {!x.restrito && x.texto && (
                      <p className="mt-2 whitespace-pre-wrap text-[12.5px] leading-relaxed text-ink-2">
                        {x.texto}
                      </p>
                    )}

                    <p className="mt-2 text-[11.5px] text-ink-3">
                      {x.restrito ? (
                        <>procedência oculta junto com o valor</>
                      ) : (
                        <>
                          {x.documentoTitulo ?? 'sem documento de origem'}
                          {x.trecho && ` · ${x.trecho}`}
                          {x.confirmadaPor && (
                            <> · confirmada por {x.confirmadaPor}</>
                          )}
                          {' · vigente desde '}
                          {x.validoDe}
                        </>
                      )}
                      {hist && (
                        <>
                          {' · '}
                          <span className="font-semibold text-amber-700">
                            alterada {hist.versoes.length - 1}× por aditivo
                          </span>
                        </>
                      )}
                    </p>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        {mudaram.length > 0 && (
          <Card title="Histórico — o que mudou, quando e por qual documento">
            <ul className="grid gap-4">
              {mudaram.map((h) => (
                <li key={h.tipo}>
                  <strong className="text-[13.5px] font-bold text-ink">
                    {especificacao(h.tipo)?.rotulo}
                  </strong>
                  <ol className="mt-1.5 grid gap-1">
                    {h.versoes.map((v) => (
                      <li
                        key={v.id}
                        className={cn(
                          'flex flex-wrap items-baseline gap-2 border-l-2 pl-3 text-[12.5px]',
                          v.estado === 'substituida'
                            ? 'border-line text-ink-3'
                            : 'border-purple-500 text-ink',
                        )}
                      >
                        <span className="tabular-nums">
                          {v.validoDe}
                          {v.validoAte ? ` – ${v.validoAte}` : ' – hoje'}
                        </span>
                        <span className="font-semibold">
                          {v.restrito ? '(valor restrito)' : valorLegivel(v.valorEstruturado)}
                        </span>
                        <span className="text-ink-3">
                          {v.documentoTitulo}
                          {v.trecho && ` · ${v.trecho}`}
                        </span>
                      </li>
                    ))}
                  </ol>
                </li>
              ))}
            </ul>
            <p className="mt-3 max-w-[80ch] text-[12.5px] text-ink-3">
              Cláusula nunca é editada — só substituída, com documento de origem. Por isso a linha
              antiga continua aqui: quem pergunta &ldquo;por que mudou?&rdquo; recebe o aditivo e a
              data.
            </p>
          </Card>
        )}

        {/* Rodapé permanente, como o PRD pede. */}
        <p className="border-t border-line pt-4 text-[12.5px] text-ink-3">
          O registro legal é o <strong className="font-semibold">documento assinado</strong>.
          Divergência entre esta ficha e o PDF é incidente de dado, e o PDF prevalece.
        </p>
      </Corpo>
    </>
  )
}
