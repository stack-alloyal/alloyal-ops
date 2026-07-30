/**
 * C12 — consolidação diária.
 *
 * É a fronteira entre dado e produto: tudo acima dela é engenharia de dados,
 * tudo abaixo é aplicação. Nenhuma tela agrega sobre `fact` em tempo real.
 *
 * O que ela faz, nesta ordem:
 *   1. lê as colunas de ORIGEM que os ciclos de captação escreveram;
 *   2. julga a qualidade por fonte e marca a competência como completa ou não;
 *   3. deriva as métricas e calcula os nove drivers, renormalizando os ausentes;
 *   4. grava o sinal com a faixa por regra;
 *   5. classifica churn silencioso pelos dois vetores;
 *   6. publica os agregados do cliente, com supressão.
 *
 * O que ela deliberadamente NÃO faz: publicar um score composto. Enquanto não
 * houver calibração contra desfecho real, o que se mostra é a regra explícita —
 * um score com pesos adivinhados erra a ordenação, o CSM percebe em duas
 * semanas, e desconfiança de número não se desfaz.
 */

import {
  calcularDrivers,
  faixaAtraso,
  faixaEngajamento,
  faixaPorRegra,
  percentil,
  severidade,
  DONO_POR_SEVERIDADE,
  DRIVERS,
  geraItemDeTrabalho,
  type DriverValue,
} from '@ops/metrics'
import type pg from 'pg'

import { verificarFrescor, type Verificacao } from './quality.js'

/**
 * Fontes que alimentam o snapshot, e os ciclos que as trazem.
 *
 * O mapeamento vive aqui porque é ele que traduz "o ciclo C8 não rodou" em "o
 * driver financeiro entra neutro" — que é a informação que a tela precisa.
 */
export const FONTES: Record<string, { readonly ciclos: readonly string[]; readonly prazoHoras: number }> = {
  replica: { ciclos: ['C1', 'C2'], prazoHoras: 26 },
  hubspot: { ciclos: ['C4', 'C5'], prazoHoras: 26 },
  clevertap: { ciclos: ['C6'], prazoHoras: 50 },
  omie: { ciclos: ['C8'], prazoHoras: 50 },
}

/**
 * Piso de adesão por segmento.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ DEF-01 EM ABERTO. Este valor é um substituto declarado, não uma decisão.  │
 * │                                                                            │
 * │ Enquanto o piso por segmento não for definido por CS e Diretoria, ele é    │
 * │ derivado como 60% da mediana do porte na própria competência, com um piso  │
 * │ absoluto por baixo. Mede a conta contra os pares dela, e marca quem está   │
 * │ MUITO pior — não quem está abaixo da média, que é sempre metade da base.   │
 * │                                                                            │
 * │ Por isso o piso usado fica gravado no detalhe da execução: quando o número │
 * │ oficial chegar, dá para comparar o que teria mudado.                       │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export const PISO_MINIMO_ABSOLUTO = 0.15

/** O piso derivado é esta fração da mediana do porte. Ver `calcularPisos`. */
export const FRACAO_DA_MEDIANA = 0.6

export interface ResumoConsolidacao {
  readonly competencia: string
  readonly contas: number
  readonly completos: number
  readonly parciais: number
  readonly sinais: number
  readonly emChurnSilencioso: number
  readonly publicados: number
  readonly suprimidos: number
  readonly pisosPorPorte: Record<string, number>
}

interface LinhaConta {
  account_id: string
  porte: string | null
  vidas_contratadas: number | null
  vidas_elegiveis: number | null
  vidas_ativadas_acum: number | null
  vidas_ativas_30d: number | null
  vidas_ativas_30d_anterior: number | null
  mau: number | null
  dau: number | null
  transacoes: number
  gmv_centavos: string
  cashback_gerado_centavos: string
  dias_atraso_max: number | null
  valor_aberto_centavos: string | null
  mrr_centavos: string | null
  dias_sem_contato: number | null
  dias_sem_transacao: number | null
  competencias_em_queda: number
}

const num = (v: string | number | null): number | null =>
  v === null || v === undefined ? null : Number(v)

export async function consolidar(
  pool: pg.Pool,
  competencia: string,
  opts: { readonly agora?: Date } = {},
): Promise<ResumoConsolidacao> {
  const agora = opts.agora ?? new Date()

  // ── Frescor das fontes, uma vez para toda a competência ───────────────────
  const frescor = await julgarFontes(pool, agora)

  // ── Uma passada, tudo que a consolidação precisa ──────────────────────────
  const { rows } = await pool.query<LinhaConta>(
    `WITH anterior AS (
       SELECT account_id, vidas_ativas_30d
         FROM metrics.daily_snapshot
        WHERE competencia = $1::date - INTERVAL '30 days'
     ),
     queda AS (
       SELECT s.account_id,
              count(*) FILTER (
                WHERE s.vidas_ativas_30d < a.vidas_ativas_30d * 0.85
              ) AS competencias_em_queda
         FROM metrics.daily_snapshot s
         JOIN metrics.daily_snapshot a
           ON a.account_id = s.account_id
          AND a.competencia = s.competencia - INTERVAL '30 days'
        WHERE s.competencia BETWEEN $1::date - INTERVAL '60 days' AND $1::date
        GROUP BY s.account_id
     ),
     contato AS (
       SELECT account_id, max(ocorreu_em) AS ultimo FROM fact.activity GROUP BY account_id
     ),
     transacao AS (
       SELECT account_id, max(dia) AS ultimo
         FROM fact.transaction_daily WHERE transacoes > 0 GROUP BY account_id
     )
     SELECT s.account_id, a.porte,
            s.vidas_contratadas, s.vidas_elegiveis, s.vidas_ativadas_acum, s.vidas_ativas_30d,
            ant.vidas_ativas_30d AS vidas_ativas_30d_anterior,
            s.mau, s.dau, s.transacoes, s.gmv_centavos, s.cashback_gerado_centavos,
            s.dias_atraso_max, s.valor_aberto_centavos, s.mrr_centavos,
            ($1::date - c.ultimo::date) AS dias_sem_contato,
            ($1::date - t.ultimo)       AS dias_sem_transacao,
            COALESCE(q.competencias_em_queda, 0)::int AS competencias_em_queda
       FROM metrics.daily_snapshot s
       JOIN core.account a  ON a.id = s.account_id
       LEFT JOIN anterior ant ON ant.account_id = s.account_id
       LEFT JOIN queda q      ON q.account_id = s.account_id
       LEFT JOIN contato c    ON c.account_id = s.account_id
       LEFT JOIN transacao t  ON t.account_id = s.account_id
      WHERE s.competencia = $1`,
    [competencia],
  )

  if (rows.length === 0) {
    return {
      competencia,
      contas: 0,
      completos: 0,
      parciais: 0,
      sinais: 0,
      emChurnSilencioso: 0,
      publicados: 0,
      suprimidos: 0,
      pisosPorPorte: {},
    }
  }

  // ── Contexto de base: piso por porte e população de intensidade ───────────
  const pisosPorPorte = calcularPisos(rows)
  const intensidades = rows
    .map(intensidade)
    .filter((v): v is number => v !== null)

  const cliente = await pool.connect()
  let completos = 0
  let parciais = 0
  let emChurnSilencioso = 0
  let publicados = 0
  let suprimidos = 0

  try {
    await cliente.query('BEGIN')

    for (const r of rows) {
      // ── Qualidade por fonte, por conta ──
      // Coluna nula significa que a fonte não entregou PARA ESTA CONTA — o que
      // é diferente de a fonte estar fora do ar. As duas coisas viram o mesmo
      // efeito no driver, mas o motivo registrado é diferente.
      const qualidade = qualidadePorConta(r, frescor)
      const completo = Object.values(qualidade).every((q) => q.status === 'ok')
      if (completo) completos++
      else parciais++

      await cliente.query(
        `UPDATE metrics.daily_snapshot
            SET completo = $3, qualidade_por_fonte = $4, gerado_em = now()
          WHERE competencia = $1 AND account_id = $2`,
        [competencia, r.account_id, completo, JSON.stringify(qualidade)],
      )

      // ── Derivadas ──
      const elegiveis = num(r.vidas_elegiveis)
      const ativas = num(r.vidas_ativas_30d)
      const adesao30d = elegiveis && elegiveis > 0 && ativas !== null ? ativas / elegiveis : null
      const anteriores = num(r.vidas_ativas_30d_anterior)
      const adesaoAnterior =
        elegiveis && elegiveis > 0 && anteriores !== null ? anteriores / elegiveis : null
      const contratadas = num(r.vidas_contratadas)
      const cobertura =
        contratadas && contratadas > 0 && elegiveis !== null ? elegiveis / contratadas : null

      const piso = pisosPorPorte[r.porte ?? 'sem_porte'] ?? PISO_MINIMO_ABSOLUTO

      // ── Drivers ──
      const drivers = calcularDrivers({
        adesao30d,
        adesao30dAnterior: adesaoAnterior,
        pisoSegmento: piso,
        coberturaCadastral: cobertura,
        diasAtrasoMax: qualidade['omie']?.status === 'ausente' ? null : num(r.dias_atraso_max),
        percentilIntensidade: (() => {
          const v = intensidade(r)
          return v === null ? null : percentil(v, intensidades)
        })(),
        diasDesdeUltimoContato: num(r.dias_sem_contato),
        mau: num(r.mau),
        dau: num(r.dau),
        // Sem fonte ainda: os drivers saem da conta por renormalização, em vez
        // de entrar como zero e penalizar a conta por integração inexistente.
        csat: null,
        nps: null,
      })

      await gravarSinal(cliente, competencia, r.account_id, drivers, completo)

      // ── Churn silencioso ──
      const marcou = await gravarChurnSilencioso(cliente, competencia, r, adesao30d, piso)
      if (marcou) emChurnSilencioso++

      // ── Agregados do cliente, com supressão ──
      const p = await publicar(cliente, competencia, r, { adesao30d, cobertura })
      publicados += p.publicados
      suprimidos += p.suprimidos
    }

    await cliente.query('COMMIT')
  } catch (err) {
    await cliente.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    cliente.release()
  }

  return {
    competencia,
    contas: rows.length,
    completos,
    parciais,
    sinais: rows.length,
    emChurnSilencioso,
    publicados,
    suprimidos,
    pisosPorPorte,
  }
}

// ── Qualidade ───────────────────────────────────────────────────────────────

type StatusFonte = { readonly atualizado_em: string | null; readonly status: 'ok' | 'defasado' | 'ausente' }

async function julgarFontes(pool: pg.Pool, agora: Date): Promise<Record<string, Verificacao & { ultimo: Date | null }>> {
  const { rows } = await pool.query<{ ciclo: string; ultimo: Date }>(
    `SELECT ciclo, max(terminado_em) AS ultimo
       FROM ops.cycle_run WHERE status = 'ok' GROUP BY ciclo`,
  )
  const porCiclo = new Map(rows.map((r) => [r.ciclo, r.ultimo]))

  const saida: Record<string, Verificacao & { ultimo: Date | null }> = {}
  for (const [fonte, cfg] of Object.entries(FONTES)) {
    // A fonte é tão fresca quanto o mais recente dos ciclos que a trazem.
    const datas = cfg.ciclos.map((c) => porCiclo.get(c)).filter((d): d is Date => !!d)
    const ultimo = datas.length ? new Date(Math.max(...datas.map((d) => d.getTime()))) : null
    saida[fonte] = {
      ...verificarFrescor(fonte, ultimo, cfg.prazoHoras * 3_600_000, agora),
      ultimo,
    }
  }
  return saida
}

/**
 * Estado de cada fonte para uma conta.
 *
 * Duas causas diferentes com o mesmo efeito no driver, e o registro guarda qual
 * foi: a coluna estar nula (a fonte não cobre esta conta) ou o ciclo estar
 * atrasado (a fonte está fora do ar).
 */
function qualidadePorConta(
  r: LinhaConta,
  frescor: Record<string, Verificacao & { ultimo: Date | null }>,
): Record<string, StatusFonte> {
  const colunasPresentes: Record<string, boolean> = {
    replica: r.vidas_elegiveis !== null,
    hubspot: r.vidas_contratadas !== null,
    clevertap: r.mau !== null,
    omie: r.dias_atraso_max !== null,
  }

  const saida: Record<string, StatusFonte> = {}
  for (const fonte of Object.keys(FONTES)) {
    const f = frescor[fonte]
    const iso = f?.ultimo ? f.ultimo.toISOString() : null
    if (!colunasPresentes[fonte]) {
      saida[fonte] = { atualizado_em: iso, status: 'ausente' }
      continue
    }
    // Sem histórico de execução não dá para afirmar que está velho — e afirmar
    // sem base marcaria toda a massa de desenvolvimento como defasada.
    saida[fonte] = { atualizado_em: iso, status: f && f.ultimo && !f.passou ? 'defasado' : 'ok' }
  }
  return saida
}

// ── Piso por segmento ───────────────────────────────────────────────────────

function calcularPisos(rows: readonly LinhaConta[]): Record<string, number> {
  const porPorte = new Map<string, number[]>()
  for (const r of rows) {
    const el = num(r.vidas_elegiveis)
    const at = num(r.vidas_ativas_30d)
    if (!el || el <= 0 || at === null) continue
    const chave = r.porte ?? 'sem_porte'
    porPorte.set(chave, [...(porPorte.get(chave) ?? []), at / el])
  }

  const pisos: Record<string, number> = {}
  for (const [porte, valores] of porPorte) {
    const ord = [...valores].sort((a, b) => a - b)
    const mediana = ord[Math.floor(ord.length / 2)] ?? PISO_MINIMO_ABSOLUTO
    // O piso é uma FRAÇÃO da mediana, não a mediana.
    //
    // Usar a mediana como piso significa que metade da base está sempre abaixo
    // dele — por definição, todo dia, mesmo com a base inteira saudável. O que
    // se quer marcar não é "abaixo da média", é "muito pior que os pares": 40%
    // abaixo da mediana do próprio porte é uma diferença que alguém explica.
    //
    // E nunca abaixo do mínimo absoluto, senão uma base inteira ruim faz o piso
    // descer junto até ninguém ficar em risco.
    pisos[porte] = Math.max(PISO_MINIMO_ABSOLUTO, mediana * FRACAO_DA_MEDIANA)
  }
  return pisos
}

function intensidade(r: LinhaConta): number | null {
  const ativas = num(r.vidas_ativas_30d)
  if (!ativas || ativas <= 0) return null
  return r.transacoes / ativas
}

// ── Escrita ─────────────────────────────────────────────────────────────────

async function gravarSinal(
  c: pg.PoolClient,
  competencia: string,
  accountId: string,
  drivers: readonly DriverValue[],
  completo: boolean,
): Promise<void> {
  const disponiveis = drivers.filter((d) => d.valor !== null)
  const faixa = faixaPorRegra(drivers)
  const pesoTotal = DRIVERS.filter((d) => disponiveis.some((x) => x.id === d.id)).reduce(
    (a, d) => a + d.peso,
    0,
  )

  await c.query(
    `INSERT INTO metrics.signal
       (competencia, account_id, score_composto, score_calibrado, drivers_usados,
        parcial, faixa_por_regra, faixa_final, gerado_em)
     VALUES ($1,$2,NULL,false,$3,$4,$5,$5,now())
     ON CONFLICT (competencia, account_id) DO UPDATE SET
        drivers_usados = EXCLUDED.drivers_usados, parcial = EXCLUDED.parcial,
        faixa_por_regra = EXCLUDED.faixa_por_regra,
        -- O override manual, quando ativo e no prazo, vence a regra. Ele fica
        -- FORA da soma e por isso não é recalculado aqui.
        faixa_final = CASE
          WHEN metrics.signal.override_ativo
           AND metrics.signal.override_expira_em >= CURRENT_DATE THEN 'critico'
          ELSE EXCLUDED.faixa_por_regra END,
        gerado_em = now()`,
    [competencia, accountId, disponiveis.length, disponiveis.length < DRIVERS.length || !completo, faixa],
  )

  await c.query(
    'DELETE FROM metrics.signal_driver WHERE competencia = $1 AND account_id = $2',
    [competencia, accountId],
  )
  for (const d of drivers) {
    const def = DRIVERS.find((x) => x.id === d.id)!
    // O peso efetivo é o resultado da renormalização: driver ausente sai da
    // conta e distribui o próprio peso entre os que ficaram.
    const pesoEfetivo = d.valor === null ? 0 : pesoTotal > 0 ? (def.peso / pesoTotal) * 100 : 0
    await c.query(
      `INSERT INTO metrics.signal_driver
         (competencia, account_id, driver, valor, peso_efetivo, fonte_status)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [competencia, accountId, d.id, d.valor, pesoEfetivo.toFixed(2), d.valor === null ? 'ausente' : 'ok'],
    )
  }
}

async function gravarChurnSilencioso(
  c: pg.PoolClient,
  competencia: string,
  r: LinhaConta,
  adesao30d: number | null,
  piso: number,
): Promise<boolean> {
  if (adesao30d === null) return false

  const anteriores = num(r.vidas_ativas_30d_anterior)
  const ativas = num(r.vidas_ativas_30d) ?? 0
  const quedaRelativa = anteriores && anteriores > 0 ? Math.max(0, (anteriores - ativas) / anteriores) : 0

  const eng = faixaEngajamento(
    adesao30d,
    piso,
    quedaRelativa,
    r.competencias_em_queda,
    num(r.dias_sem_transacao) ?? 0,
  )
  const atraso = faixaAtraso(num(r.dias_atraso_max) ?? 0)
  const sev = severidade(eng, atraso)

  if (!geraItemDeTrabalho(sev)) {
    await c.query(
      'DELETE FROM metrics.silent_churn_flag WHERE competencia = $1 AND account_id = $2',
      [competencia, r.account_id],
    )
    return false
  }

  await c.query(
    `INSERT INTO metrics.silent_churn_flag
       (competencia, account_id, faixa_engajamento, faixa_atraso, severidade, dono, entrou_em, dias_na_faixa)
     VALUES ($1,$2,$3,$4,$5,$6,$1,0)
     ON CONFLICT (competencia, account_id) DO UPDATE SET
        faixa_engajamento = EXCLUDED.faixa_engajamento,
        faixa_atraso = EXCLUDED.faixa_atraso,
        severidade = EXCLUDED.severidade,
        dono = EXCLUDED.dono`,
    [competencia, r.account_id, eng, atraso, sev, DONO_POR_SEVERIDADE[sev]],
  )
  return true
}

/**
 * Publica os agregados que o cliente enxerga.
 *
 * A supressão é aplicada AQUI, na escrita — não na consulta. Recorte pequeno
 * grava `suprimido = true` e valor nulo, e o banco recusa a linha que tentar
 * gravar valor junto. Filtro de consulta se esquece; restrição de tabela não.
 */
async function publicar(
  c: pg.PoolClient,
  competencia: string,
  r: LinhaConta,
  derivadas: { adesao30d: number | null; cobertura: number | null },
): Promise<{ publicados: number; suprimidos: number }> {
  const nBase = num(r.vidas_ativas_30d) ?? 0
  const MINIMO = 5
  const suprimir = nBase < MINIMO

  const ativas = num(r.vidas_ativas_30d) ?? 0
  const valores: Record<string, number | null> = {
    adesao_30d: derivadas.adesao30d,
    cobertura_cadastral: derivadas.cobertura,
    gmv_centavos: num(r.gmv_centavos),
    cashback_gerado_centavos: num(r.cashback_gerado_centavos),
    economia_por_vida_ativa_centavos:
      ativas > 0 ? Math.round((num(r.cashback_gerado_centavos) ?? 0) / ativas) : null,
    transacoes_por_vida_ativa: ativas > 0 ? r.transacoes / ativas : null,
  }

  let publicados = 0
  let suprimidos = 0
  for (const [metrica, valor] of Object.entries(valores)) {
    await c.query(
      `INSERT INTO public_v.metric_daily (account_id, competencia, metrica, valor, n_base, suprimido)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (account_id, competencia, metrica) DO UPDATE SET
          valor = EXCLUDED.valor, n_base = EXCLUDED.n_base,
          suprimido = EXCLUDED.suprimido, gerado_em = now()`,
      [r.account_id, competencia, metrica, suprimir ? null : valor, nBase, suprimir],
    )
    if (suprimir) suprimidos++
    else publicados++
  }
  return { publicados, suprimidos }
}
