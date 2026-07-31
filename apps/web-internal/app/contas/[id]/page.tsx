import { envelope, DRIVERS } from '@ops/metrics'
import { carregarConta, ContaNaoVisivelError, type Conta360 } from '@ops/success'
import { Aviso, Badge, Card, Kpi, Metric, TOM_POR_FAIXA, Table, cn } from '@ops/ui'
import { Building2 } from 'lucide-react'
import { forbidden } from 'next/navigation'

import { Corpo, Topo } from '../../casca'
import { pool } from '../../../lib/db'
import { exigir, temEscopo } from '../../../lib/guarda'

export const dynamic = 'force-dynamic'

/**
 * T2 — Cliente 360 (doc 01, 11.2).
 *
 * Substitui a planilha que o CSM monta antes de cada reunião. O cabeçalho fixo
 * carrega os quatro números que aparecem em praticamente toda conversa de CS —
 * adesão, cobertura, atraso e dias sem contato — sempre no mesmo lugar.
 *
 * ESCOPO DESTA ENTREGA: cabeçalho, aba Visão (faixa e drivers) e itens abertos.
 * As abas Resultado, Suporte, Relacionamento e Timeline dependem de fontes que
 * ainda não chegam (C7 tickets, C10 WhatsApp, C11 Calendar) — e estão listadas
 * como ausentes em vez de omitidas, para que a falta seja visível e não pareça
 * decisão de produto.
 */

const REAIS = (c: string | null) =>
  c === null
    ? '—'
    : (Number(c) / 100).toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'BRL',
        maximumFractionDigits: 0,
      })

const FAIXA: Record<string, string> = {
  saudavel: 'Saudável',
  atencao: 'Atenção',
  risco: 'Risco',
  critico: 'Crítico',
}

const FAIXA_ATRASO = (d: number | null) =>
  d === null
    ? '—'
    : d === 0
      ? 'adimplente'
      : d < 31
        ? '1–30 dias'
        : d < 61
          ? '31–60 dias'
          : d < 91
            ? '61–90 dias'
            : 'acima de 90 dias'

/** As abas que existirão, e o que falta para cada uma. Ver comentário do topo. */
const ABAS_PENDENTES: ReadonlyArray<{ nome: string; falta: string }> = [
  { nome: 'Resultado', falta: 'GMV e cashback por vida dependem do ciclo C1 contra a réplica' },
  { nome: 'Suporte', falta: 'tickets do Hub (C7) entram quando a F4 existir' },
  { nome: 'Relacionamento', falta: 'timeline unificada precisa de WhatsApp (C10) e Calendar (C11)' },
  { nome: 'Plano', falta: 'projetos e playbooks entram junto com a F3' },
]

export default async function Conta({ params }: { params: Promise<{ id: string }> }) {
  const id = await exigir((p) => temEscopo(p.contas), 'ficha de cliente')
  const { id: accountId } = await params

  let c: Conta360
  try {
    c = await carregarConta(pool(), id, accountId)
  } catch (err) {
    // Conta de outra carteira e conta inexistente dão a MESMA resposta: separar
    // as duas transforma a URL num oráculo que confirma a existência da conta.
    if (err instanceof ContaNaoVisivelError) forbidden()
    throw err
  }

  const geradoEm = c.geradoEm ? new Date(c.geradoEm) : new Date()
  const comp = c.competencia ?? new Date().toISOString().slice(0, 10)
  // O envelope carrega estado do dado e linhagem para dentro de cada número —
  // é o que faz "parcial" e "defasado" nunca aparecerem iguais a um dado íntegro.
  const env = (metrica: string, valor: number | null, fonte: string, ciclo: string) => {
    // O status REAL da fonte, escrito pela consolidação por conta e por
    // competência. Passar 'ok' fixo aqui faria o número defasado aparecer igual
    // ao íntegro — que é exatamente o que o envelope existe para impedir.
    const q = c.qualidadePorFonte[fonte] as
      | { atualizado_em: string | null; status: 'ok' | 'defasado' | 'ausente' }
      | undefined
    return envelope({
      metrica,
      valor,
      competencia: comp,
      geradoEm,
      fontes: [
        { fonte, ciclo, atualizado_em: q?.atualizado_em ?? null, status: q?.status ?? 'ok' },
      ],
    })
  }

  const fontesAusentes = Object.entries(
    c.qualidadePorFonte as Record<string, { status?: string } | undefined>,
  )
    .filter(([, v]) => v?.status && v.status !== 'ok')
    .map(([k, v]) => `${k} ${v?.status}`)

  return (
    <>
      <Topo
        href="/contas"
        icone={Building2}
        titulo={c.razaoSocial}
        proposito={[c.setor, c.porte].filter(Boolean).join(' · ')}
        acoes={
          /* Cor nunca sozinha (D9): a faixa é rótulo + tom. O score vem do lado
             com a marca de calibração — score não calibrado é palpite ordenado. */
          c.faixaFinal ? (
            <span className="flex items-center gap-2">
              <Badge tone={TOM_POR_FAIXA[c.faixaFinal] ?? 'slate'}>
                {FAIXA[c.faixaFinal] ?? c.faixaFinal}
              </Badge>
              {c.scoreComposto !== null && (
                <span className="tabular-nums text-[12.5px] text-ink-3">
                  score {c.scoreComposto}
                  {!c.scoreCalibrado && ' · não calibrado'}
                  {c.scoreParcial && ' · parcial'}
                </span>
              )}
            </span>
          ) : (
            <Badge>sem faixa</Badge>
          )
        }
      />
      <Corpo className="grid gap-5">
        <p className="text-[13px] text-ink-2">
          {c.csmEmail && <>CSM {c.csmEmail}</>}
          {c.mrrCentavos && <> · {REAIS(c.mrrCentavos)}/mês</>}
          {c.overrideAtivo && (
            <>
              {' · '}
              <span className="font-semibold text-amber-700">faixa sobrescrita à mão</span>
            </>
          )}
        </p>

        {!c.completo && fontesAusentes.length > 0 && (
          <Aviso tom="alerta">
            Snapshot parcial de {c.competencia} — {fontesAusentes.join(' · ')}. Os números abaixo
            estão calculados sem essas fontes.
          </Aviso>
        )}

        {/* Os quatro números do cabeçalho fixo (doc 01, 11.2). */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            dados={env('adesao_30d', c.adesao30d, 'réplica', 'C1')}
            explicacao="Vidas ativas nos últimos 30 dias sobre as vidas elegíveis."
            formula="vidas_ativas_30d ÷ vidas_elegiveis"
            unidade="percentual"
            rotulo="Adesão 30d"
          />
          <Metric
            dados={env('cobertura_cadastral', c.coberturaCadastral, 'réplica', 'C2')}
            explicacao="Quanto da base contratada já foi carregada no clube."
            formula="vidas_elegiveis ÷ vidas_contratadas"
            unidade="percentual"
            rotulo="Cobertura"
          />
          <Kpi
            rotulo="Atraso"
            valor={<span className="text-[22px]">{FAIXA_ATRASO(c.diasAtrasoMax)}</span>}
            {...(c.valorAbertoCentavos && Number(c.valorAbertoCentavos) > 0
              ? { nota: `${REAIS(c.valorAbertoCentavos)} em aberto` }
              : {})}
            {...((c.diasAtrasoMax ?? 0) >= 90
              ? { tom: 'red' as const }
              : (c.diasAtrasoMax ?? 0) > 0
                ? { tom: 'amber' as const }
                : {})}
          />
          <Kpi
            rotulo="Último contato"
            valor={c.diasDesdeUltimoContato === null ? '—' : `há ${c.diasDesdeUltimoContato} d`}
            {...((c.diasDesdeUltimoContato ?? 0) > 60 ? { tom: 'amber' as const } : {})}
          />
        </div>

        {/* ── Itens abertos: por que esta conta está na fila ── */}
        {c.itensAbertos.length > 0 && (
          <Card title={`Na fila (${c.itensAbertos.length})`}>
            <ul className="grid gap-2">
              {c.itensAbertos.map((i) => (
                <li
                  key={i.id}
                  className={cn(
                    'rounded-md border border-line border-l-[3px] bg-surface-2 p-3',
                    i.prioridade === 'critica' && 'border-l-red',
                    i.prioridade === 'alta' && 'border-l-orange-500',
                    i.prioridade === 'media' && 'border-l-amber',
                  )}
                >
                  <p className="text-[13.5px] font-semibold text-ink">{i.motivo}</p>
                  <p className="mt-0.5 text-[12px] text-ink-3">
                    {i.gatilho} · {i.familia} · prazo {i.prazo}
                    {i.estado === 'backlog' && ' · em backlog'}
                    {i.donoEmail !== id.email && ` · ${i.donoEmail}`}
                  </p>
                </li>
              ))}
            </ul>
          </Card>
        )}

        {/* ── Visão: os drivers que formaram a faixa ── */}
        <Card title="Drivers">
          {c.drivers.length === 0 ? (
            <p className="text-[13px] text-ink-3">
              Nenhum driver calculado para {c.competencia ?? 'esta conta'}. A faixa só aparece
              depois da consolidação diária (C12).
            </p>
          ) : (
            <Table
              cols={['Driver', 'Valor', 'Peso efetivo', 'Fonte']}
              rows={c.drivers.map((d) => {
                const spec = DRIVERS.find((x) => x.id === d.driver)
                return [
                  <>
                    <span className="font-semibold">{d.driver}</span>
                    {spec && (
                      <span className="mt-0.5 block max-w-[60ch] text-[12px] text-ink-3">
                        {spec.explicacao}
                      </span>
                    )}
                  </>,
                  <span className="tabular-nums">{d.valor ?? '—'}</span>,
                  /* Peso EFETIVO, não nominal: quando uma fonte cai, o peso dela é
                     redistribuído. Já vem em pontos percentuais — não multiplicar. */
                  <span className="tabular-nums">{d.pesoEfetivo.toFixed(1)}%</span>,
                  d.fonteStatus === 'ok' ? (
                    <Badge tone="green">ok</Badge>
                  ) : (
                    <Badge tone="slate">{d.fonteStatus}</Badge>
                  ),
                ]
              })}
            />
          )}
        </Card>

        {/* ── Contrato ── */}
        <Card title="Contrato">
          {c.mrrCentavos ? (
            <dl className="grid grid-cols-[max-content_1fr] gap-x-5 gap-y-2 text-[13.5px]">
              <dt className="text-ink-3">MRR</dt>
              <dd className="tabular-nums">{REAIS(c.mrrCentavos)}/mês</dd>
              <dt className="text-ink-3">Vigência</dt>
              <dd className="tabular-nums">
                {c.inicio} a {c.vigenciaFim ?? 'indeterminada'}
                {c.diasParaVigenciaFim !== null &&
                  ` · ${c.diasParaVigenciaFim < 0 ? `vencida há ${-c.diasParaVigenciaFim}` : `faltam ${c.diasParaVigenciaFim}`} d`}
              </dd>
              <dt className="text-ink-3">Aviso prévio</dt>
              {/* Ao lado do vencimento de propósito: "faltam 60 dias" parece folga
                  até se ver que o aviso prévio é de 90 e o prazo já passou. */}
              <dd className="tabular-nums">
                {c.avisoPrevioDias === null ? '—' : `${c.avisoPrevioDias} dias`}
                {c.avisoPrevioDias !== null &&
                  c.diasParaVigenciaFim !== null &&
                  c.diasParaVigenciaFim < c.avisoPrevioDias && (
                    <strong className="ml-2 font-semibold text-red">
                      janela de aviso já aberta
                    </strong>
                  )}
              </dd>
              <dt className="text-ink-3">Renovação</dt>
              <dd>{c.renovacao ?? '—'}</dd>
            </dl>
          ) : (
            <p className="text-[13px] text-ink-3">
              Nenhum contrato vigente registrado para esta conta.
            </p>
          )}
        </Card>

        {/* ── O que ainda não existe, dito em voz alta ── */}
        <details className="text-[13px] text-ink-2">
          <summary className="cursor-pointer select-none font-semibold hover:text-ink">
            {ABAS_PENDENTES.length} abas ainda não construídas
          </summary>
          <ul className="mt-2 grid gap-1 pl-4 text-ink-3">
            {ABAS_PENDENTES.map((a) => (
              <li key={a.nome} className="list-disc">
                <strong className="font-semibold text-ink-2">{a.nome}</strong> — {a.falta}
              </li>
            ))}
          </ul>
        </details>
      </Corpo>
    </>
  )
}
