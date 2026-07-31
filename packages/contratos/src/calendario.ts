import type { Identidade } from '@ops/auth'
import type pg from 'pg'

/**
 * T22 — Calendário contratual. Nenhuma data crítica descoberta pela data.
 *
 * Cinco tipos de data crítica, cada um com uma consequência diferente se passar
 * batido:
 *
 *   vencimento          → contrato acaba, e com renovação expressa não renova
 *   janela_de_aviso      → o cliente já pode denunciar; a conversa tem que ser antes
 *   reajuste            → o mês passou sem aplicar, e o índice do ano se perde
 *   obrigacao           → obrigação contratual descumprida
 *   aditivo_pendente     → aditivo negociado e nunca assinado, que é o pior dos
 *                          cinco: as duas partes acham que vale, e não vale
 *
 * A janela de aviso é a que a operação mais esquece, e é a mais caroa: com
 * renovação AUTOMÁTICA, deixar a janela passar é ficar preso a mais um ciclo; com
 * renovação EXPRESSA, é perder o contrato por silêncio. A mesma data, duas
 * consequências opostas — e é por isso que `renovacao` é cláusula tipada.
 */

export type TipoData =
  | 'vencimento'
  | 'janela_de_aviso'
  | 'reajuste'
  | 'obrigacao'
  | 'aditivo_pendente'

export interface DataCritica {
  tipo: TipoData
  accountId: string
  conta: string
  /** A data em que a coisa acontece. */
  data: string
  /** Dias até lá; negativo quando já passou. */
  dias: number
  /** O que a pessoa precisa ler para decidir. */
  descricao: string
  mrrCentavos: string | null
  /** `null` quando o tipo não tem dono definido — obrigação tem, vencimento não. */
  donoEmail: string | null
  /** Verdadeiro quando passar da data causa perda irreversível naquele ciclo. */
  irreversivel: boolean
}

/** Quantos meses à frente o calendário olha por padrão. */
export const HORIZONTE_MESES = 6

/**
 * As datas críticas dos próximos meses, já em uma lista ordenada.
 *
 * Uma consulta só, com UNION, e não cinco chamadas: a tela precisa da lista
 * ORDENADA POR DATA entre tipos diferentes, e ordenar em memória cinco listas
 * paginadas separadamente é como um vencimento de amanhã aparece embaixo de uma
 * obrigação de daqui a três meses.
 */
export async function datasCriticas(
  db: pg.Pool,
  id: Identidade,
  opts: { hoje?: string; meses?: number } = {},
): Promise<DataCritica[]> {
  if (id.permissoes.contas === 'nenhum') return []
  const hoje = opts.hoje ?? new Date().toISOString().slice(0, 10)
  const meses = opts.meses ?? HORIZONTE_MESES
  const daBase = id.permissoes.contas === 'base'

  const { rows } = await db.query<Record<string, unknown>>(
    `WITH janela AS (SELECT $1::date AS ini, ($1::date + make_interval(months => $2))::date AS fim),
     vigentes AS (
       SELECT ct.*, a.razao_social, a.csm_email
         FROM core.contract ct
         JOIN core.account a ON a.id = ct.account_id
        WHERE ct.status_vigencia = 'vigente' AND ct.encerrado_em IS NULL
          AND ($3::boolean OR a.csm_email = $4)
     ),
     -- Aviso prévio VIGENTE, da cláusula tipada. Cláusula proposta não decide
     -- nada, então não entra: um alerta calculado sobre valor não conferido
     -- mandaria alguém agir com prazo errado.
     aviso AS (
       SELECT DISTINCT ON (account_id) account_id,
              (valor_estruturado->>'dias')::int AS dias
         FROM contracts.clause
        WHERE tipo = 'aviso_previo' AND estado = 'confirmada'
          AND (valido_ate IS NULL OR valido_ate > $1::date)
        ORDER BY account_id, valido_de DESC
     ),
     renov AS (
       SELECT DISTINCT ON (account_id) account_id, valor_estruturado->>'valor' AS modo
         FROM contracts.clause
        WHERE tipo = 'renovacao' AND estado = 'confirmada'
          AND (valido_ate IS NULL OR valido_ate > $1::date)
        ORDER BY account_id, valido_de DESC
     )

     -- ── Vencimento ──
     SELECT 'vencimento' AS tipo, v.id AS account_id, v.razao_social AS conta,
            to_char(v.vigencia_fim,'YYYY-MM-DD') AS data,
            (v.vigencia_fim - $1::date) AS dias,
            'Vigência acaba · renovação ' || COALESCE(r.modo, v.renovacao, 'não registrada') AS descricao,
            v.mrr_centavos::text AS mrr, v.csm_email AS dono,
            -- Renovação expressa: se ninguém agir, o contrato simplesmente acaba.
            (COALESCE(r.modo, v.renovacao) = 'expressa') AS irreversivel
       FROM (SELECT ct.account_id AS id, ct.vigencia_fim, ct.mrr_centavos, ct.renovacao,
                    vg.razao_social, vg.csm_email
               FROM vigentes vg JOIN core.contract ct ON ct.id = vg.id) v
       LEFT JOIN renov r ON r.account_id = v.id
      WHERE v.vigencia_fim BETWEEN (SELECT ini FROM janela) AND (SELECT fim FROM janela)

     UNION ALL

     -- ── Janela de aviso ──
     -- A data mais esquecida e a mais caroa. Com renovação automática, deixar
     -- passar prende por mais um ciclo; com expressa, perde o contrato por silêncio.
     SELECT 'janela_de_aviso', v.account_id, v.razao_social,
            to_char(v.vigencia_fim - COALESCE(av.dias, v.aviso_previo_dias, 30), 'YYYY-MM-DD'),
            (v.vigencia_fim - COALESCE(av.dias, v.aviso_previo_dias, 30) - $1::date),
            'Cliente pode denunciar a partir daqui · ' ||
              COALESCE(av.dias, v.aviso_previo_dias, 30)::text || ' dias de aviso' ||
              CASE WHEN av.dias IS NULL THEN ' (do contrato, sem cláusula confirmada)' ELSE '' END,
            v.mrr_centavos::text, v.csm_email,
            true
       FROM vigentes v
       LEFT JOIN aviso av ON av.account_id = v.account_id
      WHERE v.vigencia_fim IS NOT NULL
        AND (v.vigencia_fim - COALESCE(av.dias, v.aviso_previo_dias, 30))
            BETWEEN (SELECT ini FROM janela) AND (SELECT fim FROM janela)

     UNION ALL

     -- ── Reajuste ──
     -- O mês do reajuste no ano corrente ou no seguinte, o que cair na janela.
     SELECT 'reajuste', v.account_id, v.razao_social,
            to_char(d.data,'YYYY-MM-DD'), (d.data - $1::date),
            'Reajuste por ' || COALESCE(v.reajuste_indice,'índice não registrado') ||
              ' · aplicar na competência de ' || to_char(d.data,'MM/YYYY'),
            v.mrr_centavos::text, v.csm_email,
            -- Reajuste não aplicado no mês não se recupera: o ano seguinte reajusta
            -- sobre a base menor, e a perda é composta.
            true
       FROM vigentes v
       CROSS JOIN LATERAL (
         SELECT make_date(y, v.reajuste_mes, 1) AS data
           FROM generate_series(
                  EXTRACT(YEAR FROM (SELECT ini FROM janela))::int,
                  EXTRACT(YEAR FROM (SELECT fim FROM janela))::int) y
       ) d
      WHERE v.reajuste_mes IS NOT NULL
        AND d.data BETWEEN (SELECT ini FROM janela) AND (SELECT fim FROM janela)

     UNION ALL

     -- ── Obrigações ──
     SELECT 'obrigacao', o.account_id, a.razao_social,
            to_char(o.prazo,'YYYY-MM-DD'), (o.prazo - $1::date),
            CASE o.parte WHEN 'alloyal' THEN 'Nossa obrigação: ' ELSE 'Obrigação do cliente: ' END
              || o.descricao,
            ct.mrr_centavos::text, COALESCE(o.dono_interno, a.csm_email),
            false
       FROM contracts.obligation o
       JOIN core.account a ON a.id = o.account_id
       LEFT JOIN LATERAL (
         SELECT mrr_centavos FROM core.contract
          WHERE account_id = o.account_id AND status_vigencia = 'vigente' LIMIT 1
       ) ct ON true
      WHERE o.estado = 'ativa' AND o.prazo IS NOT NULL
        AND o.prazo BETWEEN (SELECT ini FROM janela) AND (SELECT fim FROM janela)
        AND ($3::boolean OR a.csm_email = $4)

     UNION ALL

     -- ── Aditivo pendente de assinatura ──
     -- O pior dos cinco: as duas partes acham que vale, e não vale.
     --
     -- A data é HOJE, e não a de criação. Aditivo pendurado não é um evento de
     -- junho: é um problema de agora, que existe todos os dias até alguém assinar.
     -- Usar a data de criação o jogava num mês passado, poluía o resumo com um MRR
     -- "afetado em junho" que não afetou nada, e o fazia aparecer no fim da lista.
     -- Há quanto tempo está pendurado vai na descrição, que é onde a informação
     -- serve.
     SELECT 'aditivo_pendente', d.account_id, a.razao_social,
            to_char($1::date,'YYYY-MM-DD'), 0,
            d.titulo || ' · ' || d.status_assinatura || ' há ' ||
              ($1::date - d.criado_em::date)::text || ' dias, desde ' ||
              to_char(d.criado_em,'DD/MM/YYYY'),
            ct.mrr_centavos::text, d.carregado_por,
            -- Irreversível: enquanto não assinado, o que as duas partes combinaram
            -- não vale — e cada dia nesse estado é um dia operando sobre uma regra
            -- que não existe.
            true
       FROM contracts.document d
       JOIN core.account a ON a.id = d.account_id
       LEFT JOIN LATERAL (
         SELECT mrr_centavos FROM core.contract
          WHERE account_id = d.account_id AND status_vigencia = 'vigente' LIMIT 1
       ) ct ON true
      WHERE d.tipo IN ('aditivo','contrato','distrato')
        AND d.status_assinatura IN ('enviado','parcial')
        AND ($3::boolean OR a.csm_email = $4)

     ORDER BY 4`,
    [hoje, meses, daBase, id.email],
  )

  return rows.map((r) => ({
    tipo: r['tipo'] as TipoData,
    accountId: String(r['account_id']),
    conta: String(r['conta']),
    data: String(r['data']),
    dias: Number(r['dias']),
    descricao: String(r['descricao']),
    mrrCentavos: r['mrr'] === null ? null : String(r['mrr']),
    donoEmail: r['dono'] === null ? null : String(r['dono']),
    irreversivel: r['irreversivel'] === true,
  }))
}

export interface ResumoMes {
  mes: string
  quantas: number
  /** MRR afetado no mês — a soma distinta por conta, não por data. */
  mrrAfetadoCentavos: string
  vencidas: number
  irreversiveis: number
}

/**
 * O resumo por mês, com o MRR afetado.
 *
 * O MRR é distinto POR CONTA dentro do mês: uma conta com vencimento, janela de
 * aviso e reajuste no mesmo mês afeta o faturamento uma vez, não três. Somar por
 * data triplicaria o número que alguém levaria para uma reunião.
 */
export function resumirPorMes(datas: readonly DataCritica[]): ResumoMes[] {
  const porMes = new Map<string, { contas: Map<string, number>; vencidas: number; irrev: number; n: number }>()
  for (const d of datas) {
    const mes = d.data.slice(0, 7)
    const atual = porMes.get(mes) ?? { contas: new Map(), vencidas: 0, irrev: 0, n: 0 }
    atual.n++
    if (d.dias < 0) atual.vencidas++
    if (d.irreversivel) atual.irrev++
    if (d.mrrCentavos) atual.contas.set(d.accountId, Number(d.mrrCentavos))
    porMes.set(mes, atual)
  }
  return [...porMes.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([mes, v]) => ({
      mes,
      quantas: v.n,
      mrrAfetadoCentavos: String([...v.contas.values()].reduce((s, x) => s + x, 0)),
      vencidas: v.vencidas,
      irreversiveis: v.irrev,
    }))
}

export class ObrigacaoInvalidaError extends Error {
  constructor(mensagem: string) {
    super(mensagem)
    this.name = 'ObrigacaoInvalidaError'
  }
}

/**
 * Marca uma obrigação como cumprida.
 *
 * Exige autor e data — o banco também. Obrigação "cumprida" sem quem cumpriu é
 * exatamente o registro que não serve numa discussão com o cliente.
 */
export async function cumprirObrigacao(
  db: pg.Pool,
  id: Identidade,
  obrigacaoId: string,
): Promise<void> {
  if (id.permissoes.contas === 'nenhum') {
    throw new ObrigacaoInvalidaError('registrar cumprimento exige acesso a contas')
  }
  const { rowCount } = await db.query(
    `UPDATE contracts.obligation
        SET estado = 'cumprida', cumprida_em = current_date, cumprida_por = $2
      WHERE id = $1 AND estado = 'ativa'`,
    [obrigacaoId, id.email],
  )
  if (rowCount === 0) throw new ObrigacaoInvalidaError('esta obrigação já foi fechada')
}

/**
 * Dispensa uma obrigação, com motivo obrigatório.
 *
 * Existe porque obrigação registrada errado na extração é caso real, e a
 * alternativa — deixá-la vencida para sempre — treina o time a ignorar a lista de
 * vencidas. O motivo é obrigatório: sem ele, dispensar viraria o caminho fácil.
 */
export async function dispensarObrigacao(
  db: pg.Pool,
  id: Identidade,
  obrigacaoId: string,
  motivo: string,
): Promise<void> {
  if (!motivo.trim()) {
    throw new ObrigacaoInvalidaError(
      'dispensar exige motivo escrito — sem ele, dispensar vira o caminho fácil',
    )
  }
  const { rowCount } = await db.query(
    `UPDATE contracts.obligation
        SET estado = 'dispensada', cumprida_em = current_date, cumprida_por = $2,
            descricao = descricao || ' · dispensada: ' || $3
      WHERE id = $1 AND estado = 'ativa'`,
    [obrigacaoId, id.email, motivo.trim()],
  )
  if (rowCount === 0) throw new ObrigacaoInvalidaError('esta obrigação já foi fechada')
}

/**
 * Marca como vencidas as obrigações cujo prazo passou.
 *
 * Roda no ciclo diário. Estado explícito e não derivado da data na leitura: a tela
 * precisa distinguir "venceu e ninguém viu" de "venceu e alguém decidiu deixar
 * vencer", e as duas só se separam se o estado for gravado.
 */
export async function vencerObrigacoes(
  db: pg.Pool,
  opts: { hoje?: string } = {},
): Promise<number> {
  const hoje = opts.hoje ?? new Date().toISOString().slice(0, 10)
  const { rowCount } = await db.query(
    `UPDATE contracts.obligation
        SET estado = 'vencida'
      WHERE estado = 'ativa' AND prazo IS NOT NULL AND prazo < $1::date`,
    [hoje],
  )
  return rowCount ?? 0
}
