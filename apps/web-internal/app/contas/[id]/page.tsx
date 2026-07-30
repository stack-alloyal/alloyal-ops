import { envelope, DRIVERS } from '@ops/metrics'
import { carregarConta, ContaNaoVisivelError, type Conta360 } from '@ops/success'
import { Metric } from '@ops/ui'
import { forbidden } from 'next/navigation'

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

const FAIXA: Record<string, { rotulo: string; estado: string }> = {
  saudavel: { rotulo: 'Saudável', estado: 'ok' },
  atencao: { rotulo: 'Atenção', estado: 'parcial' },
  risco: { rotulo: 'Risco', estado: 'falha' },
  critico: { rotulo: 'Crítico', estado: 'falha' },
}

const FAIXA_ATRASO = (d: number | null) =>
  d === null ? '—' : d === 0 ? 'adimplente' : d < 31 ? '1–30 dias' : d < 61 ? '31–60 dias' : d < 91 ? '61–90 dias' : 'acima de 90 dias'

/** As abas que existirão, e o que falta para cada uma. Ver comentário do topo. */
const ABAS_PENDENTES: ReadonlyArray<{ nome: string; falta: string }> = [
  { nome: 'Resultado', falta: 'GMV e cashback por vida dependem do ciclo C1 contra a réplica' },
  { nome: 'Suporte', falta: 'tickets do Hub (C7) entram quando a F4 existir' },
  { nome: 'Relacionamento', falta: 'timeline unificada precisa de WhatsApp (C10) e Calendar (C11)' },
  { nome: 'Plano', falta: 'projetos e playbooks entram junto com a F3' },
]

function Cabecalho({ c }: { c: Conta360 }) {
  const faixa = c.faixaFinal ? FAIXA[c.faixaFinal] : null
  return (
    <header className="conta__cabecalho">
      <div className="conta__identidade">
        <h1>{c.razaoSocial}</h1>
        <p className="conta__meta">
          {[c.setor, c.porte].filter(Boolean).join(' · ')}
          {c.csmEmail && ` · CSM ${c.csmEmail}`}
          {c.mrrCentavos && ` · ${REAIS(c.mrrCentavos)}/mês`}
        </p>
      </div>

      {/* Cor nunca sozinha (D9): a faixa é rótulo + estado, e o score aparece do
          lado com a marca de calibração — score não calibrado é palpite ordenado. */}
      {faixa ? (
        <div className="conta__faixa" data-estado={faixa.estado}>
          <strong>{faixa.rotulo}</strong>
          {c.scoreComposto !== null && (
            <small>
              score {c.scoreComposto}
              {!c.scoreCalibrado && ' · não calibrado'}
              {c.scoreParcial && ' · parcial'}
            </small>
          )}
          {c.overrideAtivo && <small data-estado="parcial">faixa sobrescrita à mão</small>}
        </div>
      ) : (
        <div className="conta__faixa" data-estado="pendente">
          <strong>sem faixa</strong>
          <small>nenhum sinal calculado para esta conta</small>
        </div>
      )}
    </header>
  )
}

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
    <section className="conta">
      <Cabecalho c={c} />

      {!c.completo && fontesAusentes.length > 0 && (
        <p className="conta__aviso" data-estado="parcial">
          Snapshot parcial de {c.competencia} — {fontesAusentes.join(' · ')}. Os números
          abaixo estão calculados sem essas fontes.
        </p>
      )}

      {/* Os quatro números do cabeçalho fixo (doc 01, 11.2). */}
      <div className="conta__numeros">
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
        <div className="conta__numero">
          <span className="conta__rotulo">Atraso</span>
          <strong data-estado={(c.diasAtrasoMax ?? 0) >= 90 ? 'falha' : (c.diasAtrasoMax ?? 0) > 0 ? 'parcial' : 'ok'}>
            {FAIXA_ATRASO(c.diasAtrasoMax)}
          </strong>
          {c.valorAbertoCentavos && Number(c.valorAbertoCentavos) > 0 && (
            <small>{REAIS(c.valorAbertoCentavos)} em aberto</small>
          )}
        </div>
        <div className="conta__numero">
          <span className="conta__rotulo">Último contato</span>
          <strong data-estado={(c.diasDesdeUltimoContato ?? 0) > 60 ? 'parcial' : 'ok'}>
            {c.diasDesdeUltimoContato === null ? '—' : `há ${c.diasDesdeUltimoContato} d`}
          </strong>
        </div>
      </div>

      {/* ── Itens abertos: por que esta conta está na fila ── */}
      {c.itensAbertos.length > 0 && (
        <>
          <h2>Na fila ({c.itensAbertos.length})</h2>
          <ul className="conta__itens">
            {c.itensAbertos.map((i) => (
              <li key={i.id} data-prioridade={i.prioridade}>
                <strong>{i.motivo}</strong>
                <small>
                  {i.gatilho} · {i.familia} · prazo {i.prazo}
                  {i.estado === 'backlog' && ' · em backlog'}
                  {i.donoEmail !== id.email && ` · ${i.donoEmail}`}
                </small>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* ── Visão: os drivers que formaram a faixa ── */}
      <h2>Drivers</h2>
      {c.drivers.length === 0 ? (
        <p className="conta__vazio">
          Nenhum driver calculado para {c.competencia ?? 'esta conta'}. A faixa só aparece
          depois da consolidação diária (C12).
        </p>
      ) : (
        <table className="painel__ciclos">
          <thead>
            <tr>
              <th>Driver</th>
              <th>Valor</th>
              <th>Peso efetivo</th>
              <th>Fonte</th>
            </tr>
          </thead>
          <tbody>
            {c.drivers.map((d) => {
              const spec = DRIVERS.find((x) => x.id === d.driver)
              return (
                <tr key={d.driver}>
                  <td>
                    <strong>{d.driver}</strong>
                    {spec && <small>{spec.explicacao}</small>}
                  </td>
                  <td className="num">{d.valor ?? '—'}</td>
                  {/* Peso EFETIVO, não nominal: quando uma fonte cai, o peso
                      dela é redistribuído, e mostrar o nominal esconderia isso.
                      Já vem em pontos percentuais do banco — não multiplicar. */}
                  <td className="num">{d.pesoEfetivo.toFixed(1)}%</td>
                  <td>
                    <span data-estado={d.fonteStatus === 'ok' ? 'ok' : 'parcial'}>
                      {d.fonteStatus}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {/* ── Contrato ── */}
      <h2>Contrato</h2>
      {c.mrrCentavos ? (
        <dl className="conta__contrato">
          <dt>MRR</dt>
          <dd>{REAIS(c.mrrCentavos)}/mês</dd>
          <dt>Vigência</dt>
          <dd>
            {c.inicio} a {c.vigenciaFim ?? 'indeterminada'}
            {c.diasParaVigenciaFim !== null &&
              ` · ${c.diasParaVigenciaFim < 0 ? `vencida há ${-c.diasParaVigenciaFim}` : `faltam ${c.diasParaVigenciaFim}`} d`}
          </dd>
          <dt>Aviso prévio</dt>
          {/* Ao lado do vencimento de propósito: "faltam 60 dias" parece folga
              até se ver que o aviso prévio é de 90 e o prazo já passou. */}
          <dd>
            {c.avisoPrevioDias === null ? '—' : `${c.avisoPrevioDias} dias`}
            {c.avisoPrevioDias !== null &&
              c.diasParaVigenciaFim !== null &&
              c.diasParaVigenciaFim < c.avisoPrevioDias && (
                <strong data-estado="falha"> · janela de aviso já aberta</strong>
              )}
          </dd>
          <dt>Renovação</dt>
          <dd>{c.renovacao ?? '—'}</dd>
        </dl>
      ) : (
        <p className="conta__vazio">Nenhum contrato vigente registrado para esta conta.</p>
      )}

      {/* ── O que ainda não existe, dito em voz alta ── */}
      <details className="conta__pendentes">
        <summary>{ABAS_PENDENTES.length} abas ainda não construídas</summary>
        <ul>
          {ABAS_PENDENTES.map((a) => (
            <li key={a.nome}>
              <strong>{a.nome}</strong> — {a.falta}
            </li>
          ))}
        </ul>
      </details>
    </section>
  )
}
