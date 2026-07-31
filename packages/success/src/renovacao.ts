import type { Identidade } from '@ops/auth'
import type pg from 'pg'

/**
 * Renovação — nunca descobrir um vencimento pelo vencimento.
 *
 * Doc 01: gatilho G-09 abre a janela 90 dias antes da vigência, e a meta **O6** é
 * previsão dentro de ±10% do realizado, no cenário-base, com horizonte de 90 dias.
 *
 * A parte que faz isto valer algo não é a previsão: é a MEDIÇÃO dela. Um CSM que
 * marca tudo como otimista produz um número bonito e inútil, e ninguém descobre
 * até o trimestre fechar. Por isso `acuracia()` existe desde o primeiro dia, e a
 * tela mostra o acerto ao lado da previsão — quem faz a chamada vê o próprio
 * histórico de chamadas.
 *
 * Os três cenários não são probabilidades por conta. São os limites de uma FAIXA,
 * e a faixa é a previsão honesta:
 *
 *   otimista    tudo renova                      → o teto
 *   base        renova o que não foi marcado
 *               como pessimista                  → o que o time espera
 *   pessimista  só renova o que foi marcado
 *               como otimista                    → o piso
 *
 * Número único de previsão é falsa precisão. Faixa é o que um board consegue usar.
 */

export type CenarioRenovacao = 'base' | 'otimista' | 'pessimista'
export type EstadoRenovacao = 'aberta' | 'em_negociacao' | 'renovada' | 'perdida'

/** Quantos dias antes da vigência a janela abre (doc 01, G-09). */
export const JANELA_DIAS = 90

export class RenovacaoInvalidaError extends Error {
  constructor(mensagem: string) {
    super(mensagem)
    this.name = 'RenovacaoInvalidaError'
  }
}

export class SemPermissaoRenovacao extends Error {
  constructor() {
    super('conduzir renovação exige acesso à fila de trabalho')
    this.name = 'SemPermissaoRenovacao'
  }
}

export interface Renovacao {
  id: string
  accountId: string
  conta: string
  csmEmail: string | null
  vigenciaFim: string
  mrrEmRiscoCentavos: string
  cenario: CenarioRenovacao | null
  estado: EstadoRenovacao
  desfechoEm: string | null
  nota: string | null
  /** Dias até a vigência acabar; negativo se já passou. */
  diasParaVigencia: number
  /** Aviso prévio do contrato — o prazo real de decisão, não o do vencimento. */
  avisoPrevioDias: number | null
  criadoEm: string
}

const COLUNAS = `
  r.id, r.account_id AS "accountId", a.razao_social AS conta,
  a.csm_email AS "csmEmail",
  to_char(r.vigencia_fim,'YYYY-MM-DD')  AS "vigenciaFim",
  r.mrr_em_risco_centavos::text         AS "mrrEmRiscoCentavos",
  r.cenario, r.estado,
  to_char(r.desfecho_em,'YYYY-MM-DD')   AS "desfechoEm",
  r.nota,
  (r.vigencia_fim - current_date)       AS "diasParaVigencia",
  ct.aviso_previo_dias                  AS "avisoPrevioDias",
  r.criado_em                           AS "criadoEm"`

const DE = `
  FROM success.renewal r
  JOIN core.account a ON a.id = r.account_id
  LEFT JOIN core.contract ct ON ct.id = r.contract_id`

/**
 * Abre as renovações que entraram na janela.
 *
 * Idempotente por (conta, vigência): rodar duas vezes no mesmo dia não duplica, e
 * rodar todo dia é o que garante que ninguém descubra um vencimento pelo
 * vencimento. Contrato já encerrado não gera renovação — ele não vai renovar.
 *
 * O MRR é congelado na abertura, como na saída: o contrato pode ser reajustado
 * durante a negociação, e o que estava em risco quando a janela abriu é o número
 * contra o qual a previsão será medida.
 */
export async function abrirJanela(
  db: pg.Pool,
  opts: { hoje?: string; janelaDias?: number } = {},
): Promise<{ abertas: number; jaAbertas: number }> {
  const hoje = opts.hoje ?? new Date().toISOString().slice(0, 10)
  const janela = opts.janelaDias ?? JANELA_DIAS

  const { rowCount } = await db.query(
    `INSERT INTO success.renewal
       (account_id, contract_id, vigencia_fim, mrr_em_risco_centavos, estado)
     SELECT ct.account_id, ct.id, ct.vigencia_fim, ct.mrr_centavos, 'aberta'
       FROM core.contract ct
      WHERE ct.status_vigencia = 'vigente'
        AND ct.encerrado_em IS NULL
        AND ct.vigencia_fim IS NOT NULL
        AND ct.vigencia_fim >= $1::date
        AND ct.vigencia_fim <= ($1::date + $2::int)
        -- Sem duplicar: a chave natural é (conta, vigência), e não o id do
        -- contrato — renegociar o contrato não pode abrir uma segunda renovação
        -- para o mesmo vencimento.
        AND NOT EXISTS (
          SELECT 1 FROM success.renewal r
           WHERE r.account_id = ct.account_id AND r.vigencia_fim = ct.vigencia_fim
        )`,
    [hoje, janela],
  )

  const { rows } = await db.query<{ n: string }>(
    `SELECT count(*) n FROM success.renewal
      WHERE estado IN ('aberta','em_negociacao')
        AND vigencia_fim BETWEEN $1::date AND ($1::date + $2::int)`,
    [hoje, janela],
  )
  return { abertas: rowCount ?? 0, jaAbertas: Number(rows[0]?.n ?? 0) - (rowCount ?? 0) }
}

/**
 * Registra a leitura do CSM sobre aquela renovação.
 *
 * Marcar o cenário move a renovação para `em_negociacao`: a diferença entre
 * "abriu a janela" e "alguém olhou" é o que separa uma lista de vencimentos de um
 * pipeline. Sem isso, a tela mostra 40 renovações abertas e ninguém sabe quais já
 * foram avaliadas.
 */
export async function marcarCenario(
  db: pg.Pool,
  id: Identidade,
  renovacaoId: string,
  cenario: CenarioRenovacao,
  nota?: string,
): Promise<void> {
  if (id.permissoes.fila === 'nenhum' && !id.permissoes.configurar) {
    throw new SemPermissaoRenovacao()
  }
  const { rowCount } = await db.query(
    `UPDATE success.renewal
        SET cenario = $2, estado = 'em_negociacao',
            nota = COALESCE($3, nota)
      WHERE id = $1 AND estado IN ('aberta','em_negociacao')`,
    [renovacaoId, cenario, nota ?? null],
  )
  if (rowCount === 0) {
    throw new RenovacaoInvalidaError('esta renovação já teve desfecho — o cenário não muda depois')
  }
}

/**
 * Fecha a renovação como renovada ou perdida.
 *
 * O desfecho é o que alimenta a acurácia da previsão. Sem ele a renovação fica
 * aberta para sempre e o O6 não tem contra o que medir — a meta se torna
 * inverificável, que é o mesmo que não existir.
 */
export async function darDesfecho(
  db: pg.Pool,
  id: Identidade,
  renovacaoId: string,
  desfecho: 'renovada' | 'perdida',
  nota?: string,
): Promise<void> {
  if (id.permissoes.fila === 'nenhum' && !id.permissoes.configurar) {
    throw new SemPermissaoRenovacao()
  }
  const { rowCount } = await db.query(
    `UPDATE success.renewal
        SET estado = $2, desfecho_em = current_date, nota = COALESCE($3, nota)
      WHERE id = $1 AND estado IN ('aberta','em_negociacao')`,
    [renovacaoId, desfecho, nota ?? null],
  )
  if (rowCount === 0) throw new RenovacaoInvalidaError('esta renovação já foi fechada')
}

/**
 * Marca como perdidas as renovações abertas de uma conta que saiu.
 *
 * Chamado quando um cancelamento é encerrado. Sem isto, a conta sai pela porta da
 * saída e continua na previsão de renovação como receita esperada — dois módulos
 * contando a mesma conta de formas opostas, e a previsão passa a somar receita de
 * quem já foi embora.
 */
export async function perderPorSaida(
  db: pg.PoolClient | pg.Pool,
  accountId: string,
  quem: string,
): Promise<number> {
  const { rowCount } = await db.query(
    `UPDATE success.renewal
        SET estado = 'perdida', desfecho_em = current_date,
            nota = COALESCE(nota || ' · ', '') ||
                   'fechada automaticamente: saída encerrada por ' || $2
      WHERE account_id = $1 AND estado IN ('aberta','em_negociacao')`,
    [accountId, quem],
  )
  return rowCount ?? 0
}

export async function listar(
  db: pg.Pool,
  id: Identidade,
  opts: { abertas?: boolean } = {},
): Promise<Renovacao[]> {
  if (id.permissoes.contas === 'nenhum') return []
  const daBase = id.permissoes.contas === 'base'
  const soAbertas = opts.abertas ?? false

  const { rows } = await db.query<Renovacao>(
    `SELECT ${COLUNAS} ${DE}
      WHERE ($1::boolean OR a.csm_email = $2)
        AND (NOT $3::boolean OR r.estado IN ('aberta','em_negociacao'))
      -- Aberta primeiro, e dentro dela a que vence antes: é a única parte desta
      -- tela em que o tempo corre contra.
      ORDER BY (r.estado IN ('aberta','em_negociacao')) DESC, r.vigencia_fim,
               r.mrr_em_risco_centavos DESC`,
    [daBase, id.email, soAbertas],
  )
  return rows.map((r) => ({ ...r, diasParaVigencia: Number(r.diasParaVigencia) }))
}

export interface Previsao {
  /** Renovações abertas no horizonte. */
  quantas: number
  mrrTotalCentavos: string
  /** Os três limites da faixa. Ver o comentário do topo do módulo. */
  otimistaCentavos: string
  baseCentavos: string
  pessimistaCentavos: string
  /**
   * Quantas ainda não têm cenário — contadas em `base` e reportadas à parte.
   *
   * Uma previsão que assume em silêncio que o não avaliado renova é uma previsão
   * que se lisonjeia. O número aparece para quem lê saber quanto da faixa é
   * julgamento e quanto é omissão.
   */
  semAvaliacao: number
  mrrSemAvaliacaoCentavos: string
}

/**
 * A previsão da janela, como faixa.
 *
 * O horizonte é o mesmo do G-09 e do O6: 90 dias. Mudá-lo aqui sem mudar lá faria
 * a meta ser medida contra um número que ninguém previu.
 */
export async function previsao(
  db: pg.Pool,
  opts: { hoje?: string; janelaDias?: number } = {},
): Promise<Previsao> {
  const hoje = opts.hoje ?? new Date().toISOString().slice(0, 10)
  const janela = opts.janelaDias ?? JANELA_DIAS

  const { rows } = await db.query<Record<string, string>>(
    `WITH j AS (
       SELECT * FROM success.renewal
        WHERE estado IN ('aberta','em_negociacao')
          AND vigencia_fim BETWEEN $1::date AND ($1::date + $2::int)
     )
     SELECT count(*)::text AS quantas,
            COALESCE(sum(mrr_em_risco_centavos),0)::text AS total,
            -- Otimista: tudo renova.
            COALESCE(sum(mrr_em_risco_centavos),0)::text AS otimista,
            -- Base: renova o que NÃO foi marcado como pessimista.
            COALESCE(sum(mrr_em_risco_centavos) FILTER (
              WHERE cenario IS DISTINCT FROM 'pessimista'), 0)::text AS base,
            -- Pessimista: só renova o que foi marcado como otimista.
            COALESCE(sum(mrr_em_risco_centavos) FILTER (
              WHERE cenario = 'otimista'), 0)::text AS pessimista,
            count(*) FILTER (WHERE cenario IS NULL)::text AS sem_avaliacao,
            COALESCE(sum(mrr_em_risco_centavos) FILTER (
              WHERE cenario IS NULL), 0)::text AS mrr_sem_avaliacao
       FROM j`,
    [hoje, janela],
  )
  const r = rows[0]!
  return {
    quantas: Number(r['quantas']),
    mrrTotalCentavos: r['total']!,
    otimistaCentavos: r['otimista']!,
    baseCentavos: r['base']!,
    pessimistaCentavos: r['pessimista']!,
    semAvaliacao: Number(r['sem_avaliacao']),
    mrrSemAvaliacaoCentavos: r['mrr_sem_avaliacao']!,
  }
}

export interface Acuracia {
  /** Renovações já fechadas no período medido. */
  fechadas: number
  /** Quantas o cenário acertou o desfecho. */
  acertos: number
  /** `null` abaixo do mínimo — fração sobre 3 casos é ruído. */
  taxaAcerto: number | null
  /** O que o cenário-base previu que renovaria, em centavos. */
  previstoBaseCentavos: string
  /** O que de fato renovou. */
  realizadoCentavos: string
  /**
   * O erro do O6: `|previsto − realizado| / realizado`. A meta é ≤ 0,10.
   *
   * `null` quando nada renovou: dividir por zero e mostrar ∞ faria um trimestre
   * sem renovação parecer catástrofe de previsão, quando é catástrofe de retenção.
   */
  erro: number | null
  /** Por CSM, para a conversa ser com quem faz a chamada. */
  porCsm: Array<{ csm: string; fechadas: number; acertos: number }>
}

/** Doc 01, O6: previsão dentro de ±10% do realizado. */
export const META_ERRO_O6 = 0.1

/** Abaixo disto a taxa de acerto é ruído, e mostrá-la reprova quem não errou. */
export const MINIMO_PARA_ACURACIA = 5

/**
 * Mede a previsão contra o realizado.
 *
 * Existe desde o primeiro dia de propósito. Um CSM que marca tudo como otimista
 * produz um número bonito e inútil, e sem esta função ninguém descobre até o
 * trimestre fechar — quando já não dá para corrigir a leitura de nada.
 */
export async function acuracia(
  db: pg.Pool,
  opts: { desde?: string } = {},
): Promise<Acuracia> {
  const desde =
    opts.desde ?? new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10)

  const { rows } = await db.query<Record<string, string>>(
    `WITH f AS (
       SELECT * FROM success.renewal
        WHERE estado IN ('renovada','perdida') AND desfecho_em >= $1::date
     )
     SELECT count(*)::text AS fechadas,
            -- Acerto: quem não foi marcado como pessimista renovou, ou quem foi
            -- marcado como pessimista se perdeu. Sem cenário não é acerto nem
            -- erro — é ausência de chamada, e conta como não acerto.
            count(*) FILTER (
              WHERE (cenario IN ('base','otimista') AND estado = 'renovada')
                 OR (cenario = 'pessimista' AND estado = 'perdida')
            )::text AS acertos,
            COALESCE(sum(mrr_em_risco_centavos) FILTER (
              WHERE cenario IS DISTINCT FROM 'pessimista'), 0)::text AS previsto_base,
            COALESCE(sum(mrr_em_risco_centavos) FILTER (
              WHERE estado = 'renovada'), 0)::text AS realizado
       FROM f`,
    [desde],
  )
  const r = rows[0]!
  const fechadas = Number(r['fechadas'])
  const previsto = Number(r['previsto_base'])
  const realizado = Number(r['realizado'])

  const { rows: porCsm } = await db.query<{ csm: string; fechadas: string; acertos: string }>(
    `SELECT COALESCE(a.csm_email, 'sem CSM') AS csm,
            count(*)::text AS fechadas,
            count(*) FILTER (
              WHERE (r.cenario IN ('base','otimista') AND r.estado = 'renovada')
                 OR (r.cenario = 'pessimista' AND r.estado = 'perdida')
            )::text AS acertos
       FROM success.renewal r
       JOIN core.account a ON a.id = r.account_id
      WHERE r.estado IN ('renovada','perdida') AND r.desfecho_em >= $1::date
      GROUP BY 1 ORDER BY 2 DESC`,
    [desde],
  )

  return {
    fechadas,
    acertos: Number(r['acertos']),
    taxaAcerto:
      fechadas >= MINIMO_PARA_ACURACIA
        ? Number((Number(r['acertos']) / fechadas).toFixed(3))
        : null,
    previstoBaseCentavos: r['previsto_base']!,
    realizadoCentavos: r['realizado']!,
    erro: realizado > 0 ? Number((Math.abs(previsto - realizado) / realizado).toFixed(3)) : null,
    porCsm: porCsm.map((c) => ({
      csm: c.csm,
      fechadas: Number(c.fechadas),
      acertos: Number(c.acertos),
    })),
  }
}

/** O calendário: MRR a renovar por mês, para os próximos N meses. */
export async function calendario(
  db: pg.Pool,
  meses = 12,
): Promise<Array<{ mes: string; quantas: number; mrrCentavos: string; fechadas: number }>> {
  const { rows } = await db.query<{
    mes: string
    quantas: string
    mrr: string
    fechadas: string
  }>(
    `SELECT to_char(date_trunc('month', vigencia_fim), 'YYYY-MM') AS mes,
            count(*)::text AS quantas,
            COALESCE(sum(mrr_em_risco_centavos),0)::text AS mrr,
            count(*) FILTER (WHERE estado IN ('renovada','perdida'))::text AS fechadas
       FROM success.renewal
      WHERE vigencia_fim >= date_trunc('month', current_date)
        AND vigencia_fim < date_trunc('month', current_date) + make_interval(months => $1)
      GROUP BY 1 ORDER BY 1`,
    [meses],
  )
  return rows.map((r) => ({
    mes: r.mes,
    quantas: Number(r.quantas),
    mrrCentavos: r.mrr,
    fechadas: Number(r.fechadas),
  }))
}
